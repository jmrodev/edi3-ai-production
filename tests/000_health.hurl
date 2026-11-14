GET http://localhost:8000/health
HTTP 200
[Asserts]
jsonpath "$.status" exists
