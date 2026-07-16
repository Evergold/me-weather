#!/usr/bin/env python3
import os
import re
import sys
from pathlib import Path

# Color formatting helpers
RED = "\033[91m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
RESET = "\033[0m"
BOLD = "\033[1m"

def check_spoofing(rust_files):
    """
    SPOOFING: Are caller identity boundaries verified?
    In Axum, this means checking for Authentication middleware or CorsLayer.
    """
    has_cors = False
    for path, code in rust_files.items():
        if "CorsLayer" in code or "AuthLayer" in code or "Extension" in code and "User" in code:
            has_cors = True
    
    if has_cors:
        return "PASS", "Axum router properly implements CORS or Identity validation layers."
    return "WARN", "Axum endpoints lack explicit Cross-Origin Resource Sharing (CORS) or Auth middleware, risking CSRF or identity spoofing."

def check_tampering(rust_files):
    """
    TAMPERING: Can users manipulate underlying state?
    Check ScyllaDB queries for string interpolation instead of prepared statements.
    """
    for path, code in rust_files.items():
        if "session.query" in code:
            # Check if query uses format! macro instead of ?
            if re.search(r'session\.query\(.*?format!.*?\)', code):
                return "FAIL", f"ScyllaDB query in {path} uses format! string interpolation. Extremely vulnerable to CQL Injection."
    return "PASS", "No raw string interpolated database queries detected. Data boundaries appear safe from tampering."

def check_repudiation(rust_files):
    """
    REPUDIATION: Are critical transactions securely logged?
    Check if the project uses proper `tracing` (structured logging) vs raw `println!`.
    """
    has_tracing = False
    has_println = False
    for path, code in rust_files.items():
        if "tracing::" in code or "info!(" in code:
            has_tracing = True
        if "println!(" in code:
            has_println = True
            
    if has_tracing:
        return "PASS", "Structured tracing framework detected for non-repudiation logging."
    elif has_println:
        return "WARN", "System relies on raw stdout `println!` instead of structured logging (tracing), risking loss of critical audit trails."
    return "FAIL", "No logging framework detected. Actions cannot be audited."

def check_info_disclosure(rust_files, js_files):
    """
    INFORMATION DISCLOSURE: Are we leaking tokens or stack traces?
    Check for hardcoded secrets or raw panic dumps to the client.
    """
    secret_pattern = re.compile(r'(?i)(API_KEY|SECRET|TOKEN|PASSWORD)\s*(:|=)\s*["\'][a-zA-Z0-9_\-]+["\']')
    leaks = []
    
    for path, code in {**rust_files, **js_files}.items():
        matches = secret_pattern.findall(code)
        if matches:
            leaks.append(path)
            
    if leaks:
        return "FAIL", f"Hardcoded secrets detected in files: {', '.join(leaks)}"
    return "PASS", "No statically hardcoded secrets or tokens detected in the codebase."

def check_dos(rust_files):
    """
    DENIAL OF SERVICE: Are there rate limits or crash vectors?
    Check for unchecked unwrap() or unbounded channels which can OOM or crash the server.
    """
    unwrap_count = 0
    unbounded = False
    for path, code in rust_files.items():
        unwrap_count += code.count(".unwrap()")
        if "mpsc::unbounded_channel" in code:
            unbounded = True
            
    if unbounded:
        return "FAIL", "Unbounded MPSC channels detected. A malicious client flooding packets will cause Server OOM."
    if unwrap_count > 50:
        return "WARN", f"Found {unwrap_count} instances of `.unwrap()`. High risk of unhandled panic crashing the node."
    
    return "PASS", "Channel boundaries are bounded and unwrap() usage is within acceptable limits."

def check_elevation_of_privilege(rust_files):
    """
    ELEVATION OF PRIVILEGE: Can unauthenticated users reach privileged actions?
    Check for exposed administrative WebSocket routes.
    """
    for path, code in rust_files.items():
        if "/admin" in code or "FORCE_MESHING" in code:
            if "127.0.0.1" in code and "== addr" in code:
                return "WARN", "Privileged logic bypasses authentication by trusting local loopback IPs."
                
    return "PASS", "No hardcoded IP whitelists found guarding privileged administrative logic."

def main():
    print(f"{BOLD}===================================================={RESET}")
    print(f"{BOLD}    Native Rust/WebGPU STRIDE Security Linter       {RESET}")
    print(f"{BOLD}===================================================={RESET}")

    script_dir = os.path.dirname(os.path.abspath(__file__))
    workspace_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(script_dir))))

    # Recursively load codebase
    rust_files = {}
    js_files = {}
    
    for root, _, files in os.walk(workspace_root):
        if "node_modules" in root or "target" in root or "dist" in root:
            continue
        for file in files:
            file_path = os.path.join(root, file)
            if file.endswith(".rs"):
                with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                    rust_files[file] = f.read()
            elif file.endswith(".js"):
                with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                    js_files[file] = f.read()

    # Execute STRIDE Heuristics
    results = [
        ("Spoofing", *check_spoofing(rust_files)),
        ("Tampering", *check_tampering(rust_files)),
        ("Repudiation", *check_repudiation(rust_files)),
        ("Info Leak", *check_info_disclosure(rust_files, js_files)),
        ("DoS", *check_dos(rust_files)),
        ("Privilege", *check_elevation_of_privilege(rust_files))
    ]

    # Print to stdout and save to STRIDE.md
    md_content = "# STRIDE Threat Modeling Report\n\n*Automated architectural security analysis of the Rust/WebRTC Engine.*\n\n"
    
    for pillar, status, details in results:
        # CLI Output
        status_color = GREEN if status == "PASS" else YELLOW if status == "WARN" else RED
        print(f"[{pillar:<11}] {status_color}[{status}]{RESET} - {details}")
        
        # Markdown Output
        md_content += f"### {pillar}\n"
        md_content += f"**Status:** {status}\n\n"
        md_content += f"> {details}\n\n"

    print(f"{BOLD}===================================================={RESET}")
    
    md_path = os.path.join(workspace_root, "STRIDE.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(md_content)
    
    print(f"\n{GREEN}Success: Comprehensive STRIDE report saved to {md_path}{RESET}")

if __name__ == "__main__":
    main()
