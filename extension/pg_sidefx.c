#include "postgres.h"

#include "access/htup_details.h"
#include "access/xact.h"
#include "catalog/namespace.h"
#include "catalog/pg_database.h"
#include "catalog/pg_extension.h"
#include "commands/extension.h"
#include "executor/execdesc.h"
#include "executor/executor.h"
#include "executor/spi.h"
#include "fmgr.h"
#include "lib/stringinfo.h"
#include "miscadmin.h"
#include "nodes/nodeFuncs.h"
#include "nodes/nodes.h"
#include "nodes/parsenodes.h"
#include "nodes/plannodes.h"
#include "nodes/pg_list.h"
#include "tcop/dest.h"
#include "tcop/utility.h"
#include "utils/array.h"
#include "utils/builtins.h"
#include "utils/guc.h"
#include "utils/lsyscache.h"
#include "utils/memutils.h"
#include "utils/syscache.h"
#include <ctype.h>

PG_MODULE_MAGIC;

void _PG_init(void);

static void sidefx_executor_start(QueryDesc *queryDesc, int eflags);
static void sidefx_process_utility(PlannedStmt *pstmt, const char *queryString,
									bool readOnlyTree, ProcessUtilityContext context,
									ParamListInfo params, QueryEnvironment *queryEnv,
									DestReceiver *dest, QueryCompletion *qc);

PG_FUNCTION_INFO_V1(sidefx_loader);

static ExecutorStart_hook_type prev_ExecutorStart = NULL;
static ProcessUtility_hook_type prev_ProcessUtility = NULL;
static int sidefx_executor_depth = 0;

static bool sidefx_guc_enabled = true;
static bool sidefx_guc_log_utility = false;
static char *sidefx_guc_allowed_databases = "";
static char *sidefx_guc_row_include_schemas = "";
static char *sidefx_guc_row_exclude_schemas = "";

static char *scan_result_relation(PlannedStmt *pstmt, Index scanrelid);
static const char *plan_kind(const Plan *plan);
static void append_json_escaped(StringInfo buf, const char *str);
static void plan_to_json(StringInfo buf, Plan *plan, PlannedStmt *pstmt);
static void append_child_plans(StringInfo buf, Plan *plan, PlannedStmt *pstmt, bool *first);
static bool detect_index_scan(const Plan *plan);
static void collect_index_oids(const Plan *plan, List **index_oids);
static void sidefx_capture_plan(QueryDesc *queryDesc);
static bool sidefx_append_ext_table_fqn(StringInfo out, const char *relname);
static bool sidefx_database_capture_allowed(void);
static char *sidefx_current_database_name(void);
static const char *sidefx_utility_stmt_tag(Node *stmt);
static void sidefx_extract_utility_object(Node *stmt, const char *queryString,
										  char **object_schema, char **object_type,
										  char **object_name);
static void sidefx_log_utility(Node *utilityStmt, const char *queryString);

void
_PG_init(void)
{
	DefineCustomBoolVariable("pg_sidefx.enabled",
							 "Enable plan and utility logging hooks.",
							 NULL,
							 &sidefx_guc_enabled,
							 true,
							 PGC_USERSET,
							 0,
							 NULL,
							 NULL,
							 NULL);

	DefineCustomBoolVariable("pg_sidefx.log_utility",
							 "When on, log utility (DDL, etc.) statements to sidefx_utility_log.",
							 NULL,
							 &sidefx_guc_log_utility,
							 false,
							 PGC_USERSET,
							 0,
							 NULL,
							 NULL,
							 NULL);

	DefineCustomStringVariable("pg_sidefx.allowed_databases",
							   "Comma-separated database names; empty allows all.",
							   NULL,
							   &sidefx_guc_allowed_databases,
							   "",
							   PGC_USERSET,
							   0,
							   NULL,
							   NULL,
							   NULL);

	DefineCustomStringVariable("pg_sidefx.row_include_schemas",
							   "Comma-separated schema names; empty allows all row logging.",
							   NULL,
							   &sidefx_guc_row_include_schemas,
							   "",
							   PGC_USERSET,
							   0,
							   NULL,
							   NULL,
							   NULL);

	DefineCustomStringVariable("pg_sidefx.row_exclude_schemas",
							   "Comma-separated schema names excluded from row logging.",
							   NULL,
							   &sidefx_guc_row_exclude_schemas,
							   "",
							   PGC_USERSET,
							   0,
							   NULL,
							   NULL,
							   NULL);

	MarkGUCPrefixReserved("pg_sidefx");

	prev_ExecutorStart = ExecutorStart_hook;
	ExecutorStart_hook = sidefx_executor_start;

	prev_ProcessUtility = ProcessUtility_hook;
	ProcessUtility_hook = sidefx_process_utility;
}

static bool
sidefx_csv_contains_cstr(const char *csv, const char *value)
{
	const char *p;
	size_t vlen = strlen(value);

	if (csv == NULL || csv[0] == '\0' || value == NULL)
		return false;

	for (p = csv; *p;)
	{
		const char *start;
		size_t len;

		while (*p == ' ' || *p == '\t')
			p++;
		if (*p == '\0')
			break;
		start = p;
		while (*p && *p != ',')
			p++;
		len = (size_t) (p - start);
		while (len > 0 && (start[len - 1] == ' ' || start[len - 1] == '\t'))
			len--;
		if (len == vlen && strncmp(start, value, vlen) == 0)
			return true;
		if (*p == ',')
			p++;
	}
	return false;
}

static char *
sidefx_current_database_name(void)
{
	HeapTuple tuple;
	Form_pg_database datform;
	char *name;

	tuple = SearchSysCache1(DATABASEOID, ObjectIdGetDatum(MyDatabaseId));
	if (!HeapTupleIsValid(tuple))
		return NULL;
	datform = (Form_pg_database) GETSTRUCT(tuple);
	name = pstrdup(NameStr(datform->datname));
	ReleaseSysCache(tuple);
	return name;
}

static bool
sidefx_database_capture_allowed(void)
{
	char *dbname;
	bool ok;

	if (sidefx_guc_allowed_databases == NULL || sidefx_guc_allowed_databases[0] == '\0')
		return true;

	dbname = sidefx_current_database_name();
	if (dbname == NULL)
		return false;

	ok = sidefx_csv_contains_cstr(sidefx_guc_allowed_databases, dbname);
	pfree(dbname);
	return ok;
}

static bool
sidefx_append_ext_table_fqn(StringInfo out, const char *relname)
{
	Oid extoid;
	Oid nspoid;
	char *nspname;
	char *quoted;

	extoid = get_extension_oid("pg_sidefx", true);
	if (!OidIsValid(extoid))
		return false;

	nspoid = get_extension_schema(extoid);
	nspname = get_namespace_name(nspoid);
	if (nspname == NULL)
		return false;

	quoted = quote_qualified_identifier(nspname, relname);
	appendStringInfoString(out, quoted);
	pfree(quoted);
	return true;
}

static const char *
sidefx_utility_stmt_tag(Node *stmt)
{
	if (stmt == NULL)
		return "NULL";

	switch (nodeTag(stmt))
	{
		case T_TransactionStmt:
			return "TRANSACTION";
		case T_CreateStmt:
			return "CREATE_TABLE";
		case T_CreateTableSpaceStmt:
			return "CREATE_TABLESPACE";
		case T_DropStmt:
			return "DROP";
		case T_TruncateStmt:
			return "TRUNCATE";
		case T_IndexStmt:
			return "CREATE_INDEX";
		case T_AlterTableStmt:
			return "ALTER_TABLE";
		case T_RenameStmt:
			return "RENAME";
		case T_AlterObjectSchemaStmt:
			return "ALTER_OBJECT_SCHEMA";
		case T_AlterOwnerStmt:
			return "ALTER_OWNER";
		case T_CommentStmt:
			return "COMMENT";
		case T_CopyStmt:
			return "COPY";
		case T_CreateSeqStmt:
			return "CREATE_SEQUENCE";
		case T_AlterSeqStmt:
			return "ALTER_SEQUENCE";
		case T_CreatePLangStmt:
			return "CREATE_LANGUAGE";
		case T_CreateFunctionStmt:
			return "CREATE_FUNCTION";
		case T_AlterFunctionStmt:
			return "ALTER_FUNCTION";
		case T_DefineStmt:
			return "DEFINE_AGGREGATE_OR_OPERATOR";
		case T_CompositeTypeStmt:
			return "CREATE_TYPE";
		case T_CreateEnumStmt:
			return "CREATE_ENUM";
		case T_ViewStmt:
			return "CREATE_VIEW";
		case T_CreateDomainStmt:
			return "CREATE_DOMAIN";
		case T_GrantStmt:
			return "GRANT";
		case T_DeclareCursorStmt:
			return "DECLARE_CURSOR";
		case T_VariableSetStmt:
			return "SET_VARIABLE";
		case T_VariableShowStmt:
			return "SHOW_VARIABLE";
		case T_ExplainStmt:
			return "EXPLAIN";
		case T_CreateTableAsStmt:
			return "CREATE_TABLE_AS";
		case T_RefreshMatViewStmt:
			return "REFRESH_MATERIALIZED_VIEW";
		case T_ReindexStmt:
			return "REINDEX";
		case T_VacuumStmt:
			return "VACUUM";
		case T_ClusterStmt:
			return "CLUSTER";
		case T_CreateSchemaStmt:
			return "CREATE_SCHEMA";
		case T_CreateExtensionStmt:
			return "CREATE_EXTENSION";
		case T_AlterExtensionStmt:
			return "ALTER_EXTENSION";
		case T_CreateTrigStmt:
			return "CREATE_TRIGGER";
		default:
			break;
	}
	return "UTILITY_OTHER";
}

static void
sidefx_skip_ws(const char **p)
{
	while (**p != '\0' && isspace((unsigned char) **p))
		(*p)++;
}

static bool
sidefx_lex_identifier(const char **p, char **out)
{
	const char *s;
	const char *start;
	int len;

	*out = NULL;
	sidefx_skip_ws(p);
	s = *p;
	if (*s == '\0')
		return false;

	if (*s == '"')
	{
		StringInfoData buf;

		initStringInfo(&buf);
		s++;
		while (*s)
		{
			if (*s == '"')
			{
				if (*(s + 1) == '"')
				{
					appendStringInfoChar(&buf, '"');
					s += 2;
					continue;
				}
				s++;
				break;
			}
			appendStringInfoChar(&buf, *s++);
		}
		*p = s;
		*out = pstrdup(buf.data);
		pfree(buf.data);
		return true;
	}

	start = s;
	while (*s && (isalnum((unsigned char) *s) || *s == '_'))
		s++;
	len = (int) (s - start);
	if (len <= 0)
		return false;

	*out = pnstrdup(start, len);
	*p = s;
	return true;
}

static bool
sidefx_match_prefix_ci(const char *s, const char *prefix)
{
	size_t plen = strlen(prefix);

	if (strlen(s) < plen)
		return false;
	return pg_strncasecmp(s, prefix, plen) == 0;
}

static bool
sidefx_extract_name_after_keyword(const char *queryString, const char *keyword,
								  char **object_schema, char **object_name)
{
	StringInfoData q_upper;
	StringInfoData k_upper;
	const char *scan;
	const char *orig;
	char *p;
	char *first = NULL;
	char *second = NULL;

	*object_schema = NULL;
	*object_name = NULL;
	if (queryString == NULL || keyword == NULL)
		return false;

	initStringInfo(&q_upper);
	initStringInfo(&k_upper);
	for (scan = queryString; *scan; scan++)
		appendStringInfoChar(&q_upper, pg_toupper((unsigned char) *scan));
	for (scan = keyword; *scan; scan++)
		appendStringInfoChar(&k_upper, pg_toupper((unsigned char) *scan));

	p = strstr(q_upper.data, k_upper.data);
	if (p == NULL)
	{
		pfree(q_upper.data);
		pfree(k_upper.data);
		return false;
	}

	orig = queryString + (p - q_upper.data) + strlen(keyword);
	sidefx_skip_ws(&orig);
	if (sidefx_match_prefix_ci(orig, "IF NOT EXISTS"))
	{
		orig += strlen("IF NOT EXISTS");
		sidefx_skip_ws(&orig);
	}

	if (!sidefx_lex_identifier(&orig, &first))
	{
		pfree(q_upper.data);
		pfree(k_upper.data);
		return false;
	}

	sidefx_skip_ws(&orig);
	if (*orig == '.')
	{
		orig++;
		if (!sidefx_lex_identifier(&orig, &second))
		{
			pfree(first);
			pfree(q_upper.data);
			pfree(k_upper.data);
			return false;
		}
	}

	if (second)
	{
		*object_schema = first;
		*object_name = second;
	}
	else
	{
		*object_name = first;
	}

	pfree(q_upper.data);
	pfree(k_upper.data);
	return true;
}

static void
sidefx_extract_utility_object(Node *stmt, const char *queryString,
							  char **object_schema, char **object_type,
							  char **object_name)
{
	*object_schema = NULL;
	*object_type = NULL;
	*object_name = NULL;

	if (stmt == NULL)
		return;

	switch (nodeTag(stmt))
	{
		case T_CreateStmt:
			*object_type = pstrdup("TABLE");
			(void) sidefx_extract_name_after_keyword(queryString, "TABLE",
													 object_schema, object_name);
			return;
		case T_AlterTableStmt:
			*object_type = pstrdup("TABLE");
			(void) sidefx_extract_name_after_keyword(queryString, "TABLE",
													 object_schema, object_name);
			return;
		case T_CommentStmt:
			*object_type = pstrdup("TABLE");
			(void) sidefx_extract_name_after_keyword(queryString, "TABLE",
													 object_schema, object_name);
			return;
		case T_IndexStmt:
			*object_type = pstrdup("INDEX");
			(void) sidefx_extract_name_after_keyword(queryString, "INDEX",
													 object_schema, object_name);
			return;
		case T_DropStmt:
			*object_type = pstrdup("OBJECT");
			if (sidefx_extract_name_after_keyword(queryString, "TABLE",
												  object_schema, object_name))
				return;
			if (sidefx_extract_name_after_keyword(queryString, "INDEX",
												  object_schema, object_name))
			{
				pfree(*object_type);
				*object_type = pstrdup("INDEX");
				return;
			}
			return;
		default:
			return;
	}
}

static void
sidefx_log_utility(Node *utilityStmt, const char *queryString)
{
	StringInfoData cmd;
	StringInfoData qtrunc;
	Datum values[5];
	char nulls[5] = {' ', ' ', ' ', ' ', ' '};
	Oid argtypes[5] = {TEXTOID, TEXTOID, TEXTOID, TEXTOID, TEXTOID};
	int spi_rc;
	const char *tag;
	size_t maxq = 8000;
	char *object_schema = NULL;
	char *object_type = NULL;
	char *object_name = NULL;

	if (queryString == NULL)
		return;

	tag = sidefx_utility_stmt_tag(utilityStmt);
	sidefx_extract_utility_object(utilityStmt, queryString,
								  &object_schema, &object_type, &object_name);

	initStringInfo(&qtrunc);
	if (strlen(queryString) > maxq)
		appendBinaryStringInfo(&qtrunc, queryString, (int) maxq);
	else
		appendStringInfoString(&qtrunc, queryString);

	values[0] = CStringGetTextDatum(tag);
	values[1] = CStringGetTextDatum(qtrunc.data);
	if (object_schema != NULL)
		values[2] = CStringGetTextDatum(object_schema);
	else
		nulls[2] = 'n';
	if (object_type != NULL)
		values[3] = CStringGetTextDatum(object_type);
	else
		nulls[3] = 'n';
	if (object_name != NULL)
		values[4] = CStringGetTextDatum(object_name);
	else
		nulls[4] = 'n';
	resetStringInfo(&qtrunc);

	initStringInfo(&cmd);
	appendStringInfoString(&cmd, "INSERT INTO ");
	if (!sidefx_append_ext_table_fqn(&cmd, "sidefx_utility_log"))
	{
		pfree(cmd.data);
		return;
	}

	appendStringInfoString(&cmd,
						   " (txid, stmt_tag, query_text, object_schema, object_type, object_name, correlation_label) "
						   "VALUES (txid_current()::bigint, $1::text, $2::text, $3::text, $4::text, $5::text, "
						   "(SELECT label FROM sidefx_tx_label WHERE txid = txid_current()::bigint LIMIT 1))");

	if (SPI_connect() != SPI_OK_CONNECT)
	{
		pfree(cmd.data);
		return;
	}

	spi_rc = SPI_execute_with_args(cmd.data,
								   5,
								   argtypes,
								   values,
								   nulls,
								   false,
								   0);

	if (spi_rc < 0)
		elog(DEBUG1, "pg_sidefx: utility SPI_execute_with_args failed: %d", spi_rc);

	SPI_finish();
	pfree(cmd.data);
	if (object_schema)
		pfree(object_schema);
	if (object_type)
		pfree(object_type);
	if (object_name)
		pfree(object_name);
}

static void
sidefx_process_utility(PlannedStmt *pstmt, const char *queryString, bool readOnlyTree,
					   ProcessUtilityContext context, ParamListInfo params,
					   QueryEnvironment *queryEnv, DestReceiver *dest, QueryCompletion *qc)
{
	(void) readOnlyTree;

	if (sidefx_executor_depth > 0)
	{
		if (prev_ProcessUtility)
			prev_ProcessUtility(pstmt, queryString, readOnlyTree, context,
								params, queryEnv, dest, qc);
		else
			standard_ProcessUtility(pstmt, queryString, readOnlyTree, context,
									params, queryEnv, dest, qc);
		return;
	}

	if (sidefx_guc_enabled && sidefx_database_capture_allowed() && sidefx_guc_log_utility &&
		pstmt && pstmt->commandType == CMD_UTILITY && pstmt->utilityStmt != NULL &&
		queryString != NULL)
	{
		sidefx_executor_depth++;
		sidefx_log_utility(pstmt->utilityStmt, queryString);
		sidefx_executor_depth--;
	}

	if (prev_ProcessUtility)
		prev_ProcessUtility(pstmt, queryString, readOnlyTree, context,
							params, queryEnv, dest, qc);
	else
		standard_ProcessUtility(pstmt, queryString, readOnlyTree, context,
								params, queryEnv, dest, qc);
}

Datum
sidefx_loader(PG_FUNCTION_ARGS)
{
	/* Library is loaded and hooks are installed via _PG_init. */
	PG_RETURN_VOID();
}

static char *
scan_result_relation(PlannedStmt *pstmt, Index scanrelid)
{
	RangeTblEntry *rte;

	if (pstmt == NULL || pstmt->rtable == NIL || scanrelid == 0)
		return NULL;

	if (scanrelid > list_length(pstmt->rtable))
		return NULL;

	rte = (RangeTblEntry *) list_nth(pstmt->rtable, (int) scanrelid - 1);
	if (rte->rtekind != RTE_RELATION)
		return NULL;

	return get_rel_name(rte->relid);
}

static const char *
plan_kind(const Plan *plan)
{
	switch (nodeTag(plan))
	{
		case T_Result:
			return "Result";
		case T_SeqScan:
			return "SeqScan";
		case T_IndexScan:
			return "IndexScan";
		case T_IndexOnlyScan:
			return "IndexOnlyScan";
		case T_BitmapIndexScan:
			return "BitmapIndexScan";
		case T_BitmapHeapScan:
			return "BitmapHeapScan";
		case T_SubqueryScan:
			return "SubqueryScan";
		case T_FunctionScan:
			return "FunctionScan";
		case T_ValuesScan:
			return "ValuesScan";
		case T_CteScan:
			return "CteScan";
		case T_NestLoop:
			return "NestLoop";
		case T_MergeJoin:
			return "MergeJoin";
		case T_HashJoin:
			return "HashJoin";
		case T_Hash:
			return "Hash";
		case T_Material:
			return "Material";
		case T_Sort:
			return "Sort";
		case T_Agg:
			return "Agg";
		case T_WindowAgg:
			return "WindowAgg";
		case T_Unique:
			return "Unique";
		case T_Gather:
			return "Gather";
		case T_GatherMerge:
			return "GatherMerge";
		case T_Append:
			return "Append";
		case T_MergeAppend:
			return "MergeAppend";
		case T_Group:
			return "Group";
		case T_ModifyTable:
			return "ModifyTable";
		case T_Limit:
			return "Limit";
		default:
			return "Other";
	}
}

static void
append_json_escaped(StringInfo buf, const char *str)
{
	const char *p;

	appendStringInfoChar(buf, '"');
	if (str == NULL)
	{
		appendStringInfoChar(buf, '"');
		return;
	}

	for (p = str; *p; p++)
	{
		switch (*p)
		{
			case '"':
				appendStringInfoString(buf, "\\\"");
				break;
			case '\\':
				appendStringInfoString(buf, "\\\\");
				break;
			case '\b':
				appendStringInfoString(buf, "\\b");
				break;
			case '\f':
				appendStringInfoString(buf, "\\f");
				break;
			case '\n':
				appendStringInfoString(buf, "\\n");
				break;
			case '\r':
				appendStringInfoString(buf, "\\r");
				break;
			case '\t':
				appendStringInfoString(buf, "\\t");
				break;
			default:
				if ((unsigned char) *p < 0x20)
					appendStringInfo(buf, "\\u%04x", (unsigned char) *p);
				else
					appendStringInfoChar(buf, *p);
				break;
		}
	}
	appendStringInfoChar(buf, '"');
}

static void
append_child_plans(StringInfo buf, Plan *plan, PlannedStmt *pstmt, bool *first)
{
	ListCell *lc;

	if (plan->lefttree)
	{
		if (!(*first))
			appendStringInfoChar(buf, ',');
		*first = false;
		plan_to_json(buf, plan->lefttree, pstmt);
	}

	if (plan->righttree)
	{
		if (!(*first))
			appendStringInfoChar(buf, ',');
		*first = false;
		plan_to_json(buf, plan->righttree, pstmt);
	}

	switch (nodeTag(plan))
	{
		case T_Append:
			foreach(lc, ((Append *) plan)->appendplans)
			{
				if (!(*first))
					appendStringInfoChar(buf, ',');
				*first = false;
				plan_to_json(buf, (Plan *) lfirst(lc), pstmt);
			}
			break;
		case T_MergeAppend:
			foreach(lc, ((MergeAppend *) plan)->mergeplans)
			{
				if (!(*first))
					appendStringInfoChar(buf, ',');
				*first = false;
				plan_to_json(buf, (Plan *) lfirst(lc), pstmt);
			}
			break;
		case T_SubqueryScan:
			{
				SubqueryScan *sq = (SubqueryScan *) plan;

				if (sq->subplan)
				{
					if (!(*first))
						appendStringInfoChar(buf, ',');
					*first = false;
					plan_to_json(buf, sq->subplan, pstmt);
				}
			}
			break;
		case T_BitmapAnd:
			foreach(lc, ((BitmapAnd *) plan)->bitmapplans)
			{
				if (!(*first))
					appendStringInfoChar(buf, ',');
				*first = false;
				plan_to_json(buf, (Plan *) lfirst(lc), pstmt);
			}
			break;
		case T_BitmapOr:
			foreach(lc, ((BitmapOr *) plan)->bitmapplans)
			{
				if (!(*first))
					appendStringInfoChar(buf, ',');
				*first = false;
				plan_to_json(buf, (Plan *) lfirst(lc), pstmt);
			}
			break;
		default:
			break;
	}
}

static void
plan_to_json(StringInfo buf, Plan *plan, PlannedStmt *pstmt)
{
	bool first_child = true;

	appendStringInfoChar(buf, '{');
	appendStringInfoString(buf, "\"kind\":\"");
	appendStringInfoString(buf, plan_kind(plan));
	appendStringInfoChar(buf, '"');

	if (IsA(plan, SeqScan) || IsA(plan, IndexScan) ||
		IsA(plan, IndexOnlyScan) || IsA(plan, BitmapHeapScan))
	{
		Scan *s = (Scan *) plan;
		char *relname = scan_result_relation(pstmt, s->scanrelid);

		appendStringInfoString(buf, ",\"relation\":");
		append_json_escaped(buf, relname);
	}

	if (IsA(plan, IndexScan))
	{
		IndexScan *is = (IndexScan *) plan;
		char *idxname = get_rel_name(is->indexid);

		appendStringInfoString(buf, ",\"index\":");
		append_json_escaped(buf, idxname);
	}
	else if (IsA(plan, IndexOnlyScan))
	{
		IndexOnlyScan *io = (IndexOnlyScan *) plan;
		char *idxname = get_rel_name(io->indexid);

		appendStringInfoString(buf, ",\"index\":");
		append_json_escaped(buf, idxname);
	}
	else if (IsA(plan, BitmapIndexScan))
	{
		BitmapIndexScan *bi = (BitmapIndexScan *) plan;
		char *idxname = get_rel_name(bi->indexid);

		appendStringInfoString(buf, ",\"index\":");
		append_json_escaped(buf, idxname);
	}

	appendStringInfoString(buf, ",\"children\":[");
	append_child_plans(buf, plan, pstmt, &first_child);
	appendStringInfoString(buf, "]}");
}

static bool
detect_index_scan(const Plan *plan)
{
	ListCell *lc;

	if (plan == NULL)
		return false;

	switch (nodeTag(plan))
	{
		case T_IndexScan:
		case T_IndexOnlyScan:
		case T_BitmapIndexScan:
			return true;
		default:
			break;
	}

	if (detect_index_scan(plan->lefttree) || detect_index_scan(plan->righttree))
		return true;

	switch (nodeTag(plan))
	{
		case T_Append:
			foreach(lc, ((Append *) plan)->appendplans)
			{
				if (detect_index_scan((Plan *) lfirst(lc)))
					return true;
			}
			break;
		case T_MergeAppend:
			foreach(lc, ((MergeAppend *) plan)->mergeplans)
			{
				if (detect_index_scan((Plan *) lfirst(lc)))
					return true;
			}
			break;
		case T_SubqueryScan:
			if (detect_index_scan(((SubqueryScan *) plan)->subplan))
				return true;
			break;
		case T_BitmapAnd:
			foreach(lc, ((BitmapAnd *) plan)->bitmapplans)
			{
				if (detect_index_scan((Plan *) lfirst(lc)))
					return true;
			}
			break;
		case T_BitmapOr:
			foreach(lc, ((BitmapOr *) plan)->bitmapplans)
			{
				if (detect_index_scan((Plan *) lfirst(lc)))
					return true;
			}
			break;
		default:
			break;
	}

	return false;
}

static void
collect_index_oids(const Plan *plan, List **index_oids)
{
	ListCell *lc;

	if (plan == NULL)
		return;

	switch (nodeTag(plan))
	{
		case T_IndexScan:
			{
				Oid idx = ((IndexScan *) plan)->indexid;

				if (!list_member_oid(*index_oids, idx))
					*index_oids = lappend_oid(*index_oids, idx);
			}
			break;
		case T_IndexOnlyScan:
			{
				Oid idx = ((IndexOnlyScan *) plan)->indexid;

				if (!list_member_oid(*index_oids, idx))
					*index_oids = lappend_oid(*index_oids, idx);
			}
			break;
		case T_BitmapIndexScan:
			{
				Oid idx = ((BitmapIndexScan *) plan)->indexid;

				if (!list_member_oid(*index_oids, idx))
					*index_oids = lappend_oid(*index_oids, idx);
			}
			break;
		default:
			break;
	}

	collect_index_oids(plan->lefttree, index_oids);
	collect_index_oids(plan->righttree, index_oids);

	switch (nodeTag(plan))
	{
		case T_Append:
			foreach(lc, ((Append *) plan)->appendplans)
				collect_index_oids((Plan *) lfirst(lc), index_oids);
			break;
		case T_MergeAppend:
			foreach(lc, ((MergeAppend *) plan)->mergeplans)
				collect_index_oids((Plan *) lfirst(lc), index_oids);
			break;
		case T_SubqueryScan:
			collect_index_oids(((SubqueryScan *) plan)->subplan, index_oids);
			break;
		case T_BitmapAnd:
			foreach(lc, ((BitmapAnd *) plan)->bitmapplans)
				collect_index_oids((Plan *) lfirst(lc), index_oids);
			break;
		case T_BitmapOr:
			foreach(lc, ((BitmapOr *) plan)->bitmapplans)
				collect_index_oids((Plan *) lfirst(lc), index_oids);
			break;
		default:
			break;
	}
}


static void
sidefx_capture_plan(QueryDesc *queryDesc)
{
	StringInfoData planbuf;
	StringInfoData cmd;
	Datum values[4];
	const char *spi_nulls = NULL;
	/*
	 * SPI_execute_with_args binds json poorly as JSONBOID Datum on some paths;
	 * pass the plan as TEXT and cast in SQL ($2::text::jsonb).
	 */
	Oid argtypes[4] = {TEXTOID, TEXTOID, BOOLOID, TEXTARRAYOID};
	int spi_rc;
	List *index_oids = NIL;
	ListCell *lc;
	bool has_index;
	Plan *plan;
	PlannedStmt *pstmt;
	ArrayType *arr;
	Datum *datums = NULL;
	int nelems;
	int i;

	if (queryDesc->plannedstmt == NULL)
		return;

	pstmt = queryDesc->plannedstmt;
	plan = pstmt->planTree;
	if (plan == NULL)
		return;

	if (queryDesc->operation == CMD_UTILITY)
		return;

	has_index = detect_index_scan(plan);

	initStringInfo(&planbuf);
	plan_to_json(&planbuf, plan, pstmt);

	if (planbuf.len == 0 || planbuf.data[0] != '{')
	{
		resetStringInfo(&planbuf);
		appendStringInfoString(&planbuf, "{\"kind\":\"UnknownPlan\",\"children\":[]}");
	}

	values[1] = CStringGetTextDatum(planbuf.data);
	resetStringInfo(&planbuf);

	collect_index_oids(plan, &index_oids);
	nelems = list_length(index_oids);
	if (nelems > 0)
	{
		datums = (Datum *) palloc(sizeof(Datum) * nelems);
		i = 0;
		foreach(lc, index_oids)
		{
			Oid idxoid = lfirst_oid(lc);
			char *idxname = get_rel_name(idxoid);

			datums[i++] = CStringGetTextDatum(idxname ? idxname : "");
		}
		arr = construct_array(datums, nelems, TEXTOID, -1, false, 'i');
	}
	else
	{
		arr = construct_empty_array(TEXTOID);
	}

	values[0] = CStringGetTextDatum(queryDesc->sourceText ? queryDesc->sourceText : "");
	values[2] = BoolGetDatum(has_index);
	values[3] = PointerGetDatum(arr);

	initStringInfo(&cmd);
	appendStringInfoString(&cmd, "INSERT INTO ");
	if (!sidefx_append_ext_table_fqn(&cmd, "sidefx_query_plan"))
	{
		pfree(cmd.data);
		if (datums)
			pfree(datums);
		return;
	}

	appendStringInfoString(&cmd,
						   " (txid, query, plan, has_index_scan, indexes_used) "
						   "VALUES (txid_current()::bigint, $1::text, $2::text::jsonb, $3::bool, $4::text[])");

	if (SPI_connect() != SPI_OK_CONNECT)
	{
		pfree(cmd.data);
		if (datums)
			pfree(datums);
		return;
	}

	spi_rc = SPI_execute_with_args(cmd.data,
								   4,
								   argtypes,
								   values,
								   spi_nulls,
								   false,
								   0);

	if (spi_rc < 0)
		elog(DEBUG1, "pg_sidefx: SPI_execute_with_args failed: %d", spi_rc);

	SPI_finish();
	pfree(cmd.data);
	if (datums)
		pfree(datums);
}

static void
sidefx_executor_start(QueryDesc *queryDesc, int eflags)
{
	if (sidefx_executor_depth > 0)
	{
		if (prev_ExecutorStart)
			prev_ExecutorStart(queryDesc, eflags);
		else
			standard_ExecutorStart(queryDesc, eflags);
		return;
	}

	if (!sidefx_guc_enabled || !sidefx_database_capture_allowed())
	{
		if (prev_ExecutorStart)
			prev_ExecutorStart(queryDesc, eflags);
		else
			standard_ExecutorStart(queryDesc, eflags);
		return;
	}

	if ((eflags & EXEC_FLAG_EXPLAIN_ONLY) != 0)
	{
		if (prev_ExecutorStart)
			prev_ExecutorStart(queryDesc, eflags);
		else
			standard_ExecutorStart(queryDesc, eflags);
		return;
	}

	if (queryDesc == NULL || queryDesc->plannedstmt == NULL ||
		queryDesc->plannedstmt->planTree == NULL)
	{
		if (prev_ExecutorStart)
			prev_ExecutorStart(queryDesc, eflags);
		else
			standard_ExecutorStart(queryDesc, eflags);
		return;
	}

	sidefx_executor_depth++;
	sidefx_capture_plan(queryDesc);
	sidefx_executor_depth--;

	if (prev_ExecutorStart)
		prev_ExecutorStart(queryDesc, eflags);
	else
		standard_ExecutorStart(queryDesc, eflags);
}
