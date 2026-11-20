# Measuring WebView2 memory on Windows

For a single-instance measurement, open one Dirlume window and note its PID in Task Manager's **Details** tab. To compare launches, keep the WebView2 Runtime version, folders, window size, and foreground activity consistent. Run the sampler for each launch and keep the profiles used in the comparison separate from other running instances.

```powershell
./scripts/measure-webview2-memory.ps1 -DirlumeProcessId 1234 -DurationSeconds 180 |
  Export-Csv -NoTypeInformation -Path ./dirlume-memory.csv
```

Each sample reports the host and its WebView2 descendants by PID, process role, and private working set in bytes. Divide by 1,048,576 for MiB. Use the **Details** tab to compare individual PIDs and the **Processes** tab to identify the WebView2 group. The renderer is one member of that group, which also contains the browser, GPU, and utility processes. For a WebView2 total, sum the descendants once per sample. For an application total, add the separate `host` row. [WebView2 process model](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model) · [Windows memory counters](https://learn.microsoft.com/en-us/windows/win32/memory/memory-performance-information)

The sampler follows the selected host's process tree. WebView2 can share a browser process across apps or instances that use the same user data folder. When measuring shared profiles, the browser and its descendants can appear under the host that started the group. Use separate profiles for per-instance comparisons.

## Investigation of variable memory readings

The controlled comparison used the same optimized v0.1.11 diagnostic executable for both frames. With the same two-panel workload, the median WebView2 private working set at 26 seconds was 135.3 MiB with Dirlume's title bar and 136.3 MiB with Windows decorations. Launch-to-launch variation exceeded the difference between the medians. The renderer and GPU process accounted for most of the increase from an empty WebView. [Original measurements for #172](https://github.com/agrynco/dirlume/issues/172#issuecomment-7051048207)

A follow-up used a local Windows debug build with the Dirlume title bar on Windows 11 Pro build 26300 and WebView2 157.0.4341.60. Each of three isolated profiles had one initial launch and one relaunch into the default workspace. The sampler ran for 125 seconds per launch at approximately 1.25-second intervals. Each measured instance had one renderer and six WebView2 processes after startup. [Source of the development build](https://github.com/agrynco/dirlume/pull/174)

| Profile | Near 8 seconds (MiB) | Near 22 seconds (MiB) | Median from 60 seconds (MiB), by launch | Highest sample (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Fresh | 157.3–161.6 | 132.9–157.8 | 128.0, 129.7, 135.0 | 161.7 |
| Reused | 154.7–168.7 | 128.6–149.1 | 125.3, 121.9, 137.4 | 168.7 |

At each launch's peak, the GPU process accounted for 61.2–64.5 MiB. Its median from 60 seconds was 40.6–43.4 MiB across the six launches. That drop was the largest change by role. The native host's median from 60 seconds was 6.1–6.9 MiB. The earlier readings above 300 MiB remain unexplained. A trace during a recurrence can identify the contributing process and how long the increase lasts.
