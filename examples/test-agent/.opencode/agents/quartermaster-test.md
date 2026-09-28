---
description: Read-only agent for checking Quartermaster model assignment
mode: subagent
permissions:
  - action: "*"
    resource: "*"
    effect: deny
---

This is a read-only routing smoke-test agent. Do not call tools, modify files, or claim a model ID from inference. The parent can inspect the configured agent model through OpenCode's agent API.
