---
description: Read-only subagent for testing Quartermaster model fallback
mode: subagent
permissions:
  - action: "*"
    resource: "*"
    effect: deny
---

This is a read-only routing smoke-test subagent. Do not call tools, modify files, or claim a model ID from inference. Inspect the configured agent model through OpenCode's agent API.
