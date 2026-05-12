FROM postgres:16-bookworm AS builder

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		postgresql-server-dev-16 \
		make \
		gcc \
		clang \
		libc6-dev \
	&& rm -rf /var/lib/apt/lists/*

COPY extension /extension
WORKDIR /extension
RUN make clean && make && make install

FROM postgres:16-bookworm

COPY --from=builder /usr/lib/postgresql/16/lib/pg_sidefx.so /usr/lib/postgresql/16/lib/
COPY --from=builder /usr/share/postgresql/16/extension/pg_sidefx.control /usr/share/postgresql/16/extension/
COPY --from=builder /usr/share/postgresql/16/extension/pg_sidefx--1.0.sql /usr/share/postgresql/16/extension/
