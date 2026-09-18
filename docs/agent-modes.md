# Agent modes: initial version

Auto, Build, Debug and Review share the existing account/model resolution and usage accounting. No extra provider/model selector, parallel execution or autonomous tool loop is added in this version.

- Auto routes requests beginning with review/audit/explain to Review. On an existing project, requests beginning with debug/fix/repair/diagnose use Debug. Other requests use Build. Explicit selection overrides routing.
- Build preserves existing single-file and multi-file generation.
- Debug adds focused repair instructions to that same generation path. It does not execute code or verify a fix.
- Review requires a project, uses a separate inspection prompt and returns a plain-text report. The server skips patch parsing/scaffolding and the browser skips version creation, preview changes and file merging. Reports are shown in the conversation, not saved as code versions.

All modes consume normal model usage, including free-trial allowance where applicable. Output estimates are approximations. Review output is limited to 8,000 tokens and may be truncated. This is model-assisted inspection, not a security certification or executed test result.

Before deployment: test authenticated estimate/generation for both project types on a preview environment, confirm billing against real provider usage, verify keyboard/mobile selection and review isolation in the browser, and run the normal regression suite. No live paid generation is part of offline unit testing.
