# type-check finding — code-generation

**Timestamp**: 2026-01-01T03:40:02Z
**Fire id**: bbbb2222
**Output path**: /demo/src/core/index.ts
**Pass**: false

## Findings

```json
{
  "pass": false,
  "errors": [
    {
      "file": "src/core/index.ts",
      "line": 12,
      "column": 3,
      "message": "Type 'string' is not assignable to type 'number'."
    },
    {
      "file": "src/core/index.ts",
      "line": 40,
      "column": 9,
      "message": "Property 'id' does not exist on type 'Item'."
    }
  ],
  "findings_count": 2
}
```
