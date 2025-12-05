# Backend One-Click Startup Script Usage Guide

## Quick Start

The simplest way to start (using default ports):

```bash
cd backend
./start.sh
```

## Custom Ports

### Change Backend Port

```bash
./start.sh --port 8080
```

### Change Database Port

```bash
./start.sh --db-port 3307
```

### Change Redis Port

```bash
./start.sh --redis-port 6380
```

### Change Multiple Ports

```bash
./start.sh --port 8080 --db-port 3307 --redis-port 6380
```

## View Help Information

```bash
./start.sh --help
```

Output example:
```
Usage: ./start.sh [OPTIONS]

Options:
  --port PORT          Backend server port (default: 8000)
  --host HOST          Backend server host (default: 0.0.0.0)
  --db-port PORT       MySQL port (default: 3306)
  --redis-port PORT    Redis port (default: 6379)
  -h, --help           Show this help message

Examples:
  ./start.sh                              # Use default ports
  ./start.sh --port 8080                  # Use custom backend port
  ./start.sh --port 8080 --db-port 3307   # Use custom backend and database ports
```

## Port Conflict Handling

If a port is already in use, the script provides friendly error messages:

```
Warning: Port 8000 (Backend) is already in use

You have two options:
1. Stop the service using this port:
   lsof -i :8000  # Find the process
   kill -9 <PID>  # Stop the process

2. Use a different port (recommended):
   ./start.sh --port 8080
   ./start.sh --port 9000

For more options, run: ./start.sh --help
```

### Find Process Using Port

```bash
lsof -i :8000
```

### Stop Process Using Port

```bash
# After finding the PID
kill -9 <PID>
```

## Script Features

The startup script automatically completes the following steps:

1. ✓ Check Python version (requires 3.8+)
2. ✓ Create and activate virtual environment
3. ✓ Install project dependencies
4. ✓ Configure environment variables (auto-create .env)
5. ✓ Check database connection
6. ✓ Check Redis connection
7. ✓ Set PYTHONPATH
8. ✓ Start development server

## Port Validation

The script automatically validates port numbers:

- ✓ Port must be a number
- ✓ Port range: 1-65535
- ✓ Check if port is already in use

## Access Services

After successful startup, you can access:

- **Backend Service**: http://localhost:8000
- **API Documentation**: http://localhost:8000/api/docs

## FAQ
## FAQ

### Q: How to stop the service?

A: Press `Ctrl+C` to stop the service. The script will automatically clean up all processes.

**Important**: If you accidentally suspended the script (shows `suspended` status), you need to:

```bash
# Method 1: Bring to foreground and stop
fg              # Bring suspended job to foreground
Ctrl+C          # Then press Ctrl+C to stop

# Method 2: Kill all suspended jobs
jobs -p | xargs kill -9

# Method 3: Find and kill specific process
lsof -i :9000   # Find the PID
kill -9 <PID>   # Kill the process
```

### Q: What if I see "Port already in use" error?

A: This usually means:
1. A previous instance is still running (check with `lsof -i :8000`)
2. A suspended job exists (check with `jobs -l`)
3. Another service is using the port

The script will provide specific instructions based on the situation.
### Q: How to modify default configuration?

A: Edit the `.env` file and modify the corresponding configuration items

### Q: What if database connection fails?

A: Ensure MySQL service is running and check the database configuration in `.env`

### Q: What if Redis connection fails?

A: Ensure Redis service is running and check the Redis configuration in `.env`

### Q: How to run on a different host?

A: Use the `--host` parameter:
```bash
./start.sh --host 127.0.0.1 --port 8080
```

## Technical Details

- **Virtual Environment**: Automatically created in `backend/venv/` directory
- **Environment Variables**: Copied from `.env.example` to `.env`
- **PYTHONPATH**: Automatically set to project root directory
- **Development Mode**: Uses `uvicorn --reload` for hot reload support

## Example Scenarios

### Scenario 1: First Time Startup

```bash
cd backend
./start.sh
```

The script will automatically complete all initialization work.

### Scenario 2: Port 8000 is Occupied

```bash
./start.sh --port 8080
```

Start the service on a different port.

### Scenario 3: Using Custom Database

```bash
# First modify database configuration in .env
# Then start
./start.sh --db-port 3307
```

### Scenario 4: Fully Custom Configuration

```bash
./start.sh --port 9000 --host 0.0.0.0 --db-port 3307 --redis-port 6380