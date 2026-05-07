FROM postgres:16-bookworm

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
