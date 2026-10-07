FROM milvusdb/milvus:v2.5.4
ENTRYPOINT ["/tini", "--", "milvus", "run", "standalone"]
