#!/usr/bin/env python3
import os
import sys
import subprocess
import time
import signal

def load_env(dot_env_path):
    """Loads variables from .env file into a dictionary."""
    env = {}
    if os.path.exists(dot_env_path):
        with open(dot_env_path, 'r') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if '=' in line:
                    k, v = line.split('=', 1)
                    env[k.strip()] = v.strip()
    return env

def main():
    print("==========================================")
    print("  GridAI Emergency Dispatch Control Room  ")
    print("==========================================")

    # 1. Load environment variables
    project_root = os.path.abspath(os.path.dirname(__file__))
    dot_env_path = os.path.join(project_root, ".env")
    env_vars = load_env(dot_env_path)

    # Determine ports and host
    backend_port = env_vars.get("BACKEND_PORT", "8000")
    frontend_port = env_vars.get("FRONTEND_PORT", "8501")
    vite_api_url = env_vars.get("VITE_API_URL", f"http://localhost:{backend_port}")
    cors_origins = env_vars.get("CORS_ORIGINS", f"http://localhost:{frontend_port},http://127.0.0.1:{frontend_port}")

    # Prepare environment dictionary for subprocesses
    sub_env = os.environ.copy()
    sub_env.update(env_vars)
    sub_env["PYTHONPATH"] = project_root
    sub_env["VITE_API_URL"] = vite_api_url
    sub_env["CORS_ORIGINS"] = cors_origins

    # Windows requires shell=True to find command scripts like npm
    use_shell = sys.platform == "win32"

    # 2. Check and install frontend dependencies if missing
    node_modules_path = os.path.join(project_root, "frontend", "node_modules")
    if not os.path.exists(node_modules_path):
        print("\n[1/3] Frontend node_modules not found. Running npm install...")
        try:
            subprocess.run(["npm", "install"], cwd=os.path.join(project_root, "frontend"), shell=use_shell, check=True)
            print("      ✅ Frontend dependencies installed successfully.")
        except subprocess.CalledProcessError as e:
            print(f"      ❌ Failed to run npm install: {e}")
            sys.exit(1)
        except FileNotFoundError:
            print("      ❌ Node.js and npm must be installed to run the frontend. Please install Node.js and try again.")
            sys.exit(1)
    else:
        print("\n[1/3] Frontend node_modules verified.")

    # 3. Start FastAPI backend
    print(f"\n[2/3] Starting FastAPI backend on http://localhost:{backend_port}...")
    
    # Locate uvicorn in virtual environment
    if sys.platform == "win32":
        uvicorn_path = os.path.join(project_root, "venv", "Scripts", "uvicorn.exe")
    else:
        uvicorn_path = os.path.join(project_root, "venv", "bin", "uvicorn")

    if not os.path.exists(uvicorn_path):
        # Fallback to system uvicorn
        uvicorn_cmd = ["uvicorn"]
    else:
        uvicorn_cmd = [uvicorn_path]

    backend_cmd = uvicorn_cmd + [
        "src.main:app",
        "--host", "0.0.0.0",
        "--port", backend_port,
        "--reload",
        "--reload-dir", os.path.join(project_root, "src")
    ]

    try:
        backend_proc = subprocess.Popen(backend_cmd, cwd=project_root, env=sub_env)
    except Exception as e:
        print(f"      ❌ Failed to start backend process: {e}")
        sys.exit(1)

    # Wait for backend to start up
    time.sleep(2)

    # 4. Start React frontend
    print(f"\n[3/3] Starting React frontend on http://localhost:{frontend_port}...")
    
    frontend_cmd = ["npm", "run", "dev", "--", "--port", frontend_port, "--host", "0.0.0.0"]
    try:
        frontend_proc = subprocess.Popen(frontend_cmd, cwd=os.path.join(project_root, "frontend"), env=sub_env, shell=use_shell)
    except Exception as e:
        print(f"      ❌ Failed to start frontend process: {e}")
        backend_proc.terminate()
        sys.exit(1)

    print("\n==========================================")
    print("  GridAI Control Room running:")
    print(f"    Backend  → http://localhost:{backend_port}")
    print(f"    Frontend → http://localhost:{frontend_port}")
    print("  Press Ctrl+C to stop all services.")
    print("==========================================")

    # 5. Handle shutdown signals
    def shutdown_handler(signum, frame):
        print("\n\n[GridAI] Shutdown signal received. Stopping all services...")
        try:
            frontend_proc.terminate()
        except Exception:
            pass
        try:
            backend_proc.terminate()
        except Exception:
            pass
        
        # Give them a moment to terminate gracefully
        time.sleep(1)
        
        try:
            frontend_proc.kill()
        except Exception:
            pass
        try:
            backend_proc.kill()
        except Exception:
            pass
        print("[GridAI] Shutdown completed. Good bye!")
        sys.exit(0)

    # Register handlers
    signal.signal(signal.SIGINT, shutdown_handler)
    signal.signal(signal.SIGTERM, shutdown_handler)

    # Keep script alive
    try:
        while True:
            # Check if subprocesses died unexpectedly
            if backend_proc.poll() is not None:
                print("\n[GridAI] Backend process exited unexpectedly.")
                break
            if frontend_proc.poll() is not None:
                print("\n[GridAI] Frontend process exited unexpectedly.")
                break
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    
    shutdown_handler(None, None)

if __name__ == "__main__":
    main()
