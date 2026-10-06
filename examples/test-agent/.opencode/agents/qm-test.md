---
description: Read-only agent for testing Quartermaster model fallback
mode: primary
permissions:
  - action: "*"
    resource: "*"
    effect: deny
---

This is a read-only routing smoke-test agent. Do not call tools, modify files, or claim a model ID from inference. Inspect the configured agent model through OpenCode's agent API.
