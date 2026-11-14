GET http://localhost:4010/health
HTTP 200
[Asserts]
header "sl-violations" not exists
jsonpath "$.status" exists
