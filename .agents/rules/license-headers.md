---
name: license-headers
description: Ensures all self-authored source files in this workspace have the appropriate MIT license header, while preserving existing Apache 2.0 or other pre-existing headers in imported files.
globs:
  - "server/**/*.py"
  - "rust-engine/**/*.rs"
  - "src/**/*.js"
  - "src/**/*.css"
  - "index.html"
alwaysApply: true
---

# License Header Rule

Any source file generated, created, or authored in this project MUST include the appropriate two-line MIT license header. 

## 1. Header Text
```text
<filename> (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
Licensed under the MIT License (see LICENSE for details)
```

## 2. Formatting by File Type
*   **Python (`.py`)**: Use `#` comments. Place the header at the very top of the file.
    *   *Exception*: If the file starts with a shebang (e.g., `#!/usr/bin/env python3`), the header MUST be placed on lines 2 and 3, directly following the shebang.
*   **Rust (`.rs`)**: Use `//` comments at the very top of the file.
*   **JavaScript (`.js`)**: Use `//` comments at the very top of the file.
*   **CSS (`.css`)**: Use `/* ... */` comment blocks at the very top of the file.
*   **HTML (`index.html`)**: Use `<!-- ... -->` comment blocks placed directly below the `<!DOCTYPE html>` declaration.

## 3. Imported & Third-Party Code (e.g., Apache 2.0)
*   If we import, vendor, or adapt files that already have an existing license header (such as an Apache 2.0 license), **do not overwrite or replace it**.
*   The pre-existing license header **MUST be preserved** at the top of the file to comply with third-party license requirements.
