# Screenshot MCP Server

A Model Context Protocol (MCP) server that enables AI assistants running in WSL to capture Windows screenshots with advanced features like monitor selection and window-specific capture.

## Features

- 📸 **Full Desktop Capture** - Capture all monitors (default behavior)
- 🖥️ **Monitor Selection** - Capture specific monitors (primary, 1, 2, etc.)
- 🪟 **Window Capture** - Capture specific windows by title match with DPI awareness
- 🔄 **Automatic Path Conversion** - Converts WSL paths to Windows paths
- 📁 **Organized Storage** - Screenshots saved to `workspace/screenshots/`
- 🎯 **DPI Aware** - Proper scaling for high-DPI displays
- 🖼️ **Full Window Capture** - Includes window shadows and borders without clipping

## Prerequisites

- Windows with WSL (Windows Subsystem for Linux)
- Node.js installed in WSL
- Claude Desktop or Claude Code with MCP support

## Installation

1. Clone this repository:
```bash
git clone https://github.com/peterparker57/screenshot-mcp.git
cd screenshot-mcp
```

2. Install dependencies:
```bash
npm install
# or with bun:
bun install
```

3. Add to your Claude configuration (`~/.claude.json` or `~/.claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "screenshot": {
      "command": "node",
      "args": [
        "/path/to/screenshot-mcp/index.js"
      ],
      "disabled": false,
      "alwaysAllow": [
        "take_screenshot"
      ]
    }
  }
}
```

4. Restart Claude Desktop/Code

## Usage

Once installed, you can ask Claude to take screenshots:

### Basic Usage
```
Take a screenshot
```

### Capture Specific Monitor
```
Take a screenshot of monitor 1
Take a screenshot of the primary monitor
```

### Capture Specific Window
```
Take a screenshot of the "Chrome" window
Take a screenshot of window titled "Visual Studio Code"
```

### Custom Filename
```
Take a screenshot and save it as "test.png"
```

## API Reference

The MCP server provides a single tool:

### `take_screenshot`

**Parameters:**
- `filename` (optional): Name for the screenshot file (default: "screenshot.png")
- `monitor` (optional): Which monitor to capture
  - `"all"` - Capture all monitors (default)
  - `"primary"` - Capture primary monitor only
  - `1`, `2`, etc. - Capture specific monitor by index
- `windowTitle` (optional): Capture a specific window by its title (partial match supported)

**Returns:**
- Success message with the file path
- Error message if capture fails

## Technical Details

### Architecture
- **MCP Server**: Node.js with `@modelcontextprotocol/sdk`
- **Screenshot Capture**: PowerShell with .NET Windows Forms
- **Communication**: Executes PowerShell commands from WSL
- **Encoding**: Base64 encoding for reliable command execution

### Window Capture Features
- **DPI Awareness**: Automatically handles high-DPI displays for crisp captures
- **Window Padding**: Adds 10px padding to capture window shadows and borders
- **Render Wait**: Waits 200ms after focusing window to ensure complete rendering
- **Bounds Checking**: Prevents negative coordinates when windows are near screen edges

### How It Works
1. MCP server receives screenshot request from Claude
2. Constructs appropriate PowerShell script based on parameters
3. Encodes script in base64 to avoid escaping issues
4. Executes PowerShell command from WSL
5. PowerShell captures screenshot using Windows Forms APIs
6. Image is saved to the workspace's screenshots folder

### Error Handling
- Filters PowerShell CLIXML output (verbose logging, not errors)
- Validates monitor indices
- Provides clear error messages for missing windows
- Automatically creates screenshots directory if needed

## Troubleshooting

### Screenshots folder not created
The server automatically creates a `screenshots` folder in your current workspace. Ensure you have write permissions.

### PowerShell execution errors
Check your PowerShell execution policy:
```powershell
Get-ExecutionPolicy
```

### Window not found errors
- Ensure the window is open and not minimized
- The title match is case-insensitive and supports partial matches
- Try using a more specific window title

### Window capture is clipped
The latest version includes automatic padding and DPI awareness. If you still experience clipping:
- Ensure you're using the latest version
- Try maximizing the window before capture
- Check if the window has unusual rendering (some apps use custom chrome)

### Path conversion issues
The server automatically converts WSL paths like `/mnt/c/...` to Windows paths like `C:\...`. Ensure your workspace is under a mounted Windows drive.

## Recent Updates

### v1.0.1
- Fixed window capture clipping issues
- Added DPI awareness for high-DPI displays
- Added padding to capture window shadows
- Improved window rendering wait time
- Added bounds checking for edge cases

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see LICENSE file for details

## Acknowledgments

- Built for use with [Claude Desktop](https://claude.ai) and Claude Code
- Uses the [Model Context Protocol](https://modelcontextprotocol.io)
- Special thanks to the WSL team for making Windows/Linux integration possible