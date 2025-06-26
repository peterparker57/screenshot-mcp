#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

const server = new Server(
  {
    name: 'screenshot-server',
    version: '1.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// PowerShell command to take a screenshot (no temp file needed)

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'take_screenshot',
        description: 'Take a screenshot of all monitors, specific monitor, or a specific window',
        inputSchema: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description: 'Filename for the screenshot (default: screenshot.png)',
              default: 'screenshot.png'
            },
            monitor: {
              type: ['string', 'number'],
              description: 'Which monitor to capture: "all" (default), "primary", or monitor number (1, 2, etc.)',
              default: 'all'
            },
            windowTitle: {
              type: 'string',
              description: 'Capture a specific window by its title (partial match supported)'
            },
            processName: {
              type: 'string',
              description: 'Capture a specific window by process name (e.g., "notepad.exe" or just "notepad")'
            }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'take_screenshot') {
    const filename = request.params.arguments?.filename || 'screenshot.png';
    const monitor = request.params.arguments?.monitor || 'all';
    const windowTitle = request.params.arguments?.windowTitle;
    const processName = request.params.arguments?.processName;
    
    // Create screenshots folder in current workspace
    const screenshotsDir = path.resolve(process.cwd(), 'screenshots');
    await fs.mkdir(screenshotsDir, { recursive: true });
    
    const outputPath = path.join(screenshotsDir, filename);
    
    // Convert WSL path to Windows path for PowerShell
    let windowsPath = outputPath;
    if (outputPath.startsWith('/mnt/')) {
      // Convert /mnt/c/... to C:\...
      windowsPath = outputPath.replace(/^\/mnt\/([a-z])\//, '$1:\\').replace(/\//g, '\\');
    }
    
    try {
      let psScript;
      
      if (windowTitle || processName) {
        // Capture specific window by title or process name
        psScript = `
          Add-Type -AssemblyName System.Windows.Forms
          Add-Type -AssemblyName System.Drawing
          Add-Type @"
            using System;
            using System.Runtime.InteropServices;
            using System.Drawing;
            
            public class Win32 {
              [DllImport("user32.dll")]
              public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
              
              [DllImport("user32.dll")]
              public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
              
              [DllImport("user32.dll")]
              public static extern bool SetForegroundWindow(IntPtr hWnd);
              
              [DllImport("user32.dll")]
              public static extern IntPtr GetForegroundWindow();
              
              [DllImport("user32.dll")]
              public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, int nFlags);
              
              [DllImport("user32.dll")]
              public static extern int SetProcessDPIAware();
              
              public struct RECT {
                public int Left;
                public int Top;
                public int Right;
                public int Bottom;
              }
            }
"@
          
          # Enable DPI awareness
          [Win32]::SetProcessDPIAware()
          
          # Find all windows and match by title or process name
          $allWindows = Get-Process | Where-Object {$_.MainWindowTitle -ne ""}
          Write-Host "Available windows:"
          $allWindows | ForEach-Object { Write-Host "  - $($_.MainWindowTitle) (Process: $($_.ProcessName))" }
          
          # Search by title or process name
          if ("${windowTitle}" -ne "") {
            $windows = $allWindows | Where-Object {$_.MainWindowTitle -like "*${windowTitle}*"}
            if ($windows.Count -eq 0) {
              Write-Host "Search term: '${windowTitle}'"
              throw "No window found with title containing: ${windowTitle}"
            }
          } elseif ("${processName}" -ne "") {
            # Strip .exe if provided
            $searchProcess = "${processName}".Replace(".exe", "")
            $windows = $allWindows | Where-Object {$_.ProcessName -like "*$searchProcess*"}
            if ($windows.Count -eq 0) {
              Write-Host "Search process: '${processName}'"
              throw "No window found for process: ${processName}"
            }
          }
          
          $window = $windows[0]
          $hwnd = $window.MainWindowHandle
          
          # Get window bounds
          $rect = New-Object Win32+RECT
          [Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
          
          # Add padding to ensure we capture the full window including shadows
          $padding = 10
          $rect.Left = [Math]::Max(0, $rect.Left - $padding)
          $rect.Top = [Math]::Max(0, $rect.Top - $padding)
          $rect.Right = $rect.Right + $padding
          $rect.Bottom = $rect.Bottom + $padding
          
          $width = $rect.Right - $rect.Left
          $height = $rect.Bottom - $rect.Top
          
          # Bring window to foreground and wait for it to fully render
          [Win32]::SetForegroundWindow($hwnd) | Out-Null
          Start-Sleep -Milliseconds 200
          
          # Capture the window with DPI awareness
          $bitmap = New-Object System.Drawing.Bitmap $width, $height
          $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
          $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
          
          $bitmap.Save('${windowsPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
          $graphics.Dispose()
          $bitmap.Dispose()
          if ("${windowTitle}" -ne "") {
            Write-Host "Screenshot of window '${windowTitle}' saved successfully"
          } else {
            Write-Host "Screenshot of process '${processName}' saved successfully"
          }
        `;
      } else if (monitor === 'all') {
        // Current behavior - capture all screens
        psScript = `
          Add-Type -AssemblyName System.Windows.Forms
          Add-Type -AssemblyName System.Drawing
          $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
          $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
          $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
          $graphics.CopyFromScreen($screen.Left, $screen.Top, 0, 0, $bitmap.Size)
          $bitmap.Save('${windowsPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
          $graphics.Dispose()
          $bitmap.Dispose()
          Write-Host 'Screenshot saved successfully'
        `;
      } else {
        // Capture specific monitor
        psScript = `
          Add-Type -AssemblyName System.Windows.Forms
          Add-Type -AssemblyName System.Drawing
          
          $screens = [System.Windows.Forms.Screen]::AllScreens
          $targetScreen = $null
          
          if ('${monitor}' -eq 'primary') {
            $targetScreen = [System.Windows.Forms.Screen]::PrimaryScreen
          } elseif ('${monitor}' -match '^\\d+$') {
            $index = [int]'${monitor}' - 1
            if ($index -ge 0 -and $index -lt $screens.Count) {
              $targetScreen = $screens[$index]
            } else {
              throw "Monitor ${monitor} not found. Available monitors: 1 to $($screens.Count)"
            }
          }
          
          if ($targetScreen -eq $null) {
            throw "Invalid monitor parameter: ${monitor}"
          }
          
          $bounds = $targetScreen.Bounds
          $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
          $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
          $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bitmap.Size)
          
          $bitmap.Save('${windowsPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
          $graphics.Dispose()
          $bitmap.Dispose()
          Write-Host "Screenshot of monitor ${monitor} saved successfully"
        `;
      }
      
      // Convert to base64 to avoid escaping issues
      const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
      
      // Execute PowerShell with encoded command (suppress CLIXML output)
      const { stdout, stderr } = await execAsync(
        `powershell.exe -ExecutionPolicy Bypass -OutputFormat Text -EncodedCommand ${encodedCommand}`
      );
      
      // PowerShell often outputs CLIXML format to stderr even on success
      // Only throw if there's a real error (not CLIXML or success messages)
      // Check if the stderr contains actual error messages
      const hasRealError = stderr && (
          stderr.includes('throw') ||
          stderr.includes('Exception') ||
          stderr.includes('not found') ||
          (stderr.includes('Error') && !stderr.includes('ErrorId'))
      );
          
      if (hasRealError) {
        // Try to extract available windows from stdout if it's a window not found error
        if (stderr.includes('No window found') && stdout) {
          console.error('Available windows from stdout:', stdout);
        }
        throw new Error(stderr);
      }
      
      // Verify file was created
      await fs.access(outputPath);
      
      return {
        content: [
          {
            type: 'text',
            text: `Screenshot saved successfully to: screenshots/${filename}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to take screenshot: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
  
  return {
    content: [
      {
        type: 'text',
        text: `Unknown tool: ${request.params.name}`
      }
    ],
    isError: true
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Screenshot MCP server running...');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
