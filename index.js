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
    version: '1.2.0',
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
            },
            folder: {
              type: 'string',
              description: 'Custom folder path to save the screenshot (supports both WSL and Windows paths). Defaults to workspace/screenshots/'
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
    const customFolder = request.params.arguments?.folder;
    
    // Debug logging
    console.error('Screenshot parameters:', {
      filename,
      monitor,
      windowTitle,
      processName,
      folder: customFolder
    });
    
    // Determine the folder to use
    let screenshotsDir;
    let windowsPath;
    
    if (customFolder) {
      // Handle custom folder - could be WSL path or Windows path
      if (customFolder.match(/^[A-Za-z]:\\/)) {
        // It's already a Windows path (e.g., "C:\Users\...")
        windowsPath = path.join(customFolder, filename).replace(/\//g, '\\');
        // Convert Windows path to WSL path for fs operations
        const driveLetter = customFolder[0].toLowerCase();
        screenshotsDir = customFolder.replace(/^[A-Za-z]:/, `/mnt/${driveLetter}`).replace(/\\/g, '/');
      } else if (customFolder.startsWith('/mnt/')) {
        // It's a WSL path
        screenshotsDir = customFolder;
        const windowsFolder = customFolder.replace(/^\/mnt\/([a-z])\//, '$1:\\').replace(/\//g, '\\');
        windowsPath = windowsFolder + '\\' + filename;
      } else {
        // It's a relative path or Linux-style absolute path
        screenshotsDir = path.resolve(customFolder);
        windowsPath = path.join(screenshotsDir.replace(/^\/mnt\/([a-z])\//, '$1:\\').replace(/\//g, '\\'), filename);
      }
    } else {
      // Default to workspace screenshots folder
      screenshotsDir = path.resolve(process.cwd(), 'screenshots');
      const outputPath = path.join(screenshotsDir, filename);
      windowsPath = outputPath.startsWith('/mnt/') 
        ? outputPath.replace(/^\/mnt\/([a-z])\//, '$1:\\').replace(/\//g, '\\')
        : outputPath;
    }
    
    // Create the directory if it doesn't exist
    await fs.mkdir(screenshotsDir, { recursive: true });
    
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
          
          # Enable per-monitor DPI awareness for accurate capture
          Add-Type @"
            using System.Runtime.InteropServices;
            public class DPI {
              [DllImport("shcore.dll")]
              public static extern int SetProcessDpiAwareness(int value);
            }
"@
          [DPI]::SetProcessDpiAwareness(2)
          [Win32]::SetProcessDPIAware() # Fallback
          
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
          # Enable per-monitor DPI awareness
          Add-Type @"
            using System.Runtime.InteropServices;
            public class DPI {
              [DllImport("shcore.dll")]
              public static extern int SetProcessDpiAwareness(int value);
            }
"@
          [DPI]::SetProcessDpiAwareness(2)
          
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
          
          # Enable DPI awareness - MUST be per-monitor for multi-monitor setups with scaling
          Add-Type @"
            using System;
            using System.Runtime.InteropServices;
            public class DPIAware {
              [DllImport("user32.dll")]
              public static extern bool SetProcessDPIAware();
              
              [DllImport("shcore.dll")]
              public static extern int SetProcessDpiAwareness(int value);
            }
"@
          # Always use per-monitor DPI awareness (2) for accurate capture
          [DPIAware]::SetProcessDpiAwareness(2)
          
          $screens = [System.Windows.Forms.Screen]::AllScreens
          $targetScreen = $null
          
          # Sort by X position ascending (left to right) to match Windows display numbering
          $sortedScreens = $screens | Sort-Object { $_.Bounds.X }
          
          # Debug: List all monitors
          Write-Host "Available monitors:"
          for ($i = 0; $i -lt $sortedScreens.Count; $i++) {
            $screen = $sortedScreens[$i]
            Write-Host "  Monitor $($i + 1): $($screen.DeviceName) - Bounds: X=$($screen.Bounds.X), Y=$($screen.Bounds.Y), Width=$($screen.Bounds.Width), Height=$($screen.Bounds.Height) - Primary: $($screen.Primary)"
          }
          
          if ('${monitor}' -eq 'primary') {
            $targetScreen = [System.Windows.Forms.Screen]::PrimaryScreen
          } elseif ('${monitor}' -match '^\\d+$') {
            $index = [int]'${monitor}' - 1
            if ($index -ge 0 -and $index -lt $sortedScreens.Count) {
              $targetScreen = $sortedScreens[$index]
            } else {
              throw "Monitor ${monitor} not found. Available monitors: 1 to $($sortedScreens.Count)"
            }
          }
          
          if ($targetScreen -eq $null) {
            throw "Invalid monitor parameter: ${monitor}"
          }
          
          $bounds = $targetScreen.Bounds
          Write-Host "Capturing monitor ${monitor} - Bounds: X=$($bounds.X), Y=$($bounds.Y), Width=$($bounds.Width), Height=$($bounds.Height)"
          
          $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
          $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
          # Use explicit coordinates for accurate capture
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
      const outputPath = path.join(screenshotsDir, filename);
      await fs.access(outputPath);
      
      // Generate appropriate success message based on folder used
      let successPath;
      if (customFolder) {
        // Show the custom folder path as provided by the user
        successPath = path.join(customFolder, filename).replace(/\\/g, '/');
      } else {
        // Show relative path for default screenshots folder
        successPath = `screenshots/${filename}`;
      }
      
      return {
        content: [
          {
            type: 'text',
            text: `Screenshot saved successfully to: ${successPath}`
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
