# Frontend One-Click Startup Script Usage Guide

## Quick Start

The simplest way to start (using default configuration):

```bash
cd frontend
./start.sh
```

## Custom Configuration

### Change Frontend Port

```bash
./start.sh --port 3001
```

### Change Backend API URL

```bash
./start.sh --api-url http://localhost:9000
```

### Multiple Custom Options

```bash
./start.sh --port 3001 --api-url http://backend:8000
```

## View Help Information

```bash
./start.sh --help
```

Output example:

```
Usage: ./start.sh [OPTIONS]

Options:
  --port PORT          Frontend server port (default: 3000)
  --api-url URL        Backend API URL (default: http://localhost:8000)
  -h, --help           Show this help message

Examples:
  ./start.sh                                    # Use default configuration
  ./start.sh --port 3001                        # Use custom frontend port
  ./start.sh --api-url http://backend:8000      # Use custom backend URL
  ./start.sh --port 3001 --api-url http://localhost:9000  # Custom port and API
```

## Port Conflict Handling

If a port is already in use, the script provides friendly error messages:

```
Warning: Port 3000 (Frontend) is already in use

You have two options:
1. Stop the service using this port:
   lsof -i :3000  # Find the process
   kill -9 <PID>  # Stop the process

2. Use a different port (recommended):
   ./start.sh --port 3001
   ./start.sh --port 3002

For more options, run: ./start.sh --help
```

### Find Process Using Port

```bash
lsof -i :3000
```

### Stop Process Using Port

```bash
# After finding the PID
kill -9 <PID>
```

## Script Features

The startup script automatically completes the following steps:

1. ✓ Check Node.js version (requires 18+)
2. ✓ Install dependencies with npm (if needed)
3. ✓ Configure environment variables (.env.local)
4. ✓ Start Next.js development server

## Port Validation

The script automatically validates port numbers:

- ✓ Port must be a number
- ✓ Port range: 1-65535
- ✓ Check if port is already in use

## Access Services

After successful startup, you can access:

- **Frontend**: http://localhost:3000
- **Backend API** (configured): http://localhost:8000

## Environment Variables

The script automatically manages `.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_USE_MOCK_API=false
NEXT_PUBLIC_LOGIN_MODE=all
I18N_LNG=en
NEXT_PUBLIC_FRONTEND_ENABLE_DISPLAY_QUOTAS=enable
```

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
lsof -i :3000   # Find the PID
kill -9 <PID>   # Kill the process
```

### Q: What if I see "Port already in use" error?

A: This usually means:

1. A previous instance is still running (check with `lsof -i :3000`)
2. A suspended job exists (check with `jobs -l`)
3. Another service is using the port

The script will provide specific instructions based on the situation.

### Q: How to connect to a remote backend?

A: Use the `--api-url` parameter:

```bash
./start.sh --api-url http://backend.example.com:8000
./start.sh --api-url http://192.168.1.100:8000
```

### Q: How to change the default language?

A: Edit `.env.local` and change `I18N_LNG`:

```env
I18N_LNG=zh-CN  # For Chinese
I18N_LNG=en     # For English
```

### Q: What if dependencies installation fails?

A: Try clearing the cache and reinstalling:

```bash
rm -rf node_modules package-lock.json
npm install
```

### Q: How to enable mock API mode?

A: Edit `.env.local` and set:

```env
NEXT_PUBLIC_USE_MOCK_API=true
```

## Technical Details

- **Package Manager**: npm (Node Package Manager)
- **Framework**: Next.js 15 with React 19
- **Development Server**: Next.js dev server with hot reload
- **Environment**: Configured via `.env.local`

## Example Scenarios

### Scenario 1: First Time Startup

```bash
cd frontend
./start.sh
```

The script will automatically install dependencies and start the server.

### Scenario 2: Port 3000 is Occupied

```bash
./start.sh --port 3001
```

Start the service on a different port.

### Scenario 3: Connect to Remote Backend

```bash
./start.sh --api-url http://backend.example.com:8000
```

Connect to a backend running on a remote server.

### Scenario 4: Development with Custom Backend Port

```bash
./start.sh --api-url http://localhost:9000
```

Connect to a backend running on a custom port locally.

### Scenario 5: Complete Custom Configuration

```bash
./start.sh --port 3001 --api-url http://192.168.1.100:8000
```

Full custom configuration with specific port and backend URL.

## Integration with Backend

To run the full stack locally:

```bash
# Terminal 1: Start backend
cd backend
./start.sh --port 8000

# Terminal 2: Start frontend
cd frontend
./start.sh --port 3000 --api-url http://localhost:8000
```

## Troubleshooting

### Issue: "Node.js is not installed"

**Solution**: Install Node.js 18 or higher from https://nodejs.org/

### Issue: "npm install" fails

**Solution**:

1. Clear npm cache: `npm cache clean --force`
2. Delete node_modules: `rm -rf node_modules`
3. Try again: `npm install`

### Issue: "Port already in use"

**Solution**:

1. Find the process: `lsof -i :3000`
2. Kill it: `kill -9 <PID>`
3. Or use a different port: `./start.sh --port 3001`

### Issue: Cannot connect to backend

**Solution**:

1. Ensure backend is running
2. Check backend URL in `.env.local`
3. Verify network connectivity
4. Check CORS settings on backend

### Issue: "Permission denied" when running script

**Solution**: Make the script executable:

```bash
chmod +x start.sh
```
