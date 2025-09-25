import { execa, ExecaError } from "execa"
import { execSync } from "child_process"
import psTree from "ps-tree"
import process from "process"

import type { RooTerminal } from "./types"
import { BaseTerminalProcess } from "./BaseTerminalProcess"

export class ExecaTerminalProcess extends BaseTerminalProcess {
	private terminalRef: WeakRef<RooTerminal>
	private aborted = false
	private pid?: number
	private subprocess?: ReturnType<typeof execa>
	private pidUpdatePromise?: Promise<void>

	constructor(terminal: RooTerminal) {
		super()

		this.terminalRef = new WeakRef(terminal)

		this.once("completed", () => {
			this.terminal.busy = false
		})
	}

	public get terminal(): RooTerminal {
		const terminal = this.terminalRef.deref()

		if (!terminal) {
			throw new Error("Unable to dereference terminal")
		}

		return terminal
	}

	public override async run(command: string) {
		this.command = command

		try {
			this.isHot = true

			this.subprocess = execa({
				shell: true,
				cwd: this.terminal.getCurrentWorkingDirectory(),
				all: true,
				stdin: "ignore", // kilocode_change: ignore stdin to prevent blocking
				env: {
					...process.env,
					// Ensure UTF-8 encoding for Ruby, CocoaPods, etc.
					LANG: "en_US.UTF-8",
					LC_ALL: "en_US.UTF-8",
				},
			})`${command}`

			this.pid = this.subprocess.pid

			// When using shell: true, the PID is for the shell, not the actual command
			// Find the actual command PID after a small delay
			if (this.pid) {
				this.pidUpdatePromise = new Promise<void>((resolve) => {
					// Use multiple attempts with increasing delays for better reliability
					const updatePidWithRetry = (attempt: number = 1) => {
						const maxAttempts = 5
						const baseDelay = 50

						setTimeout(() => {
							psTree(this.pid!, (err, children) => {
								if (!err && children.length > 0) {
									// On Windows, filter out system processes and find the most likely command process
									let actualPid: number | null = null

									if (process.platform === "win32") {
										// On Windows, look for processes that are likely the actual command
										// Skip common system processes
										const systemProcesses = ["conhost.exe", "cmd.exe", "powershell.exe", "pwsh.exe"]
										const commandChildren = children.filter(
											(child) =>
												!systemProcesses.some((sysProc) =>
													child.COMMAND?.toLowerCase().includes(sysProc.toLowerCase()),
												),
										)

										if (commandChildren.length > 0) {
											actualPid = parseInt(commandChildren[0].PID)
										}
									} else {
										// On Unix-like systems, first child is usually the command
										actualPid = parseInt(children[0].PID)
									}

									if (actualPid && !isNaN(actualPid)) {
										console.log(
											`[ExecaTerminalProcess#run] Updated PID from ${this.pid} to ${actualPid} (${children[0].COMMAND || "unknown"})`,
										)
										this.pid = actualPid
										resolve()
										return
									}
								}

								// Retry if we haven't found a suitable PID and haven't exceeded max attempts
								if (attempt < maxAttempts) {
									updatePidWithRetry(attempt + 1)
								} else {
									console.warn(
										`[ExecaTerminalProcess#run] Could not find actual command PID after ${maxAttempts} attempts`,
									)
									resolve()
								}
							})
						}, baseDelay * attempt) // Exponential backoff: 50ms, 100ms, 150ms, 200ms, 250ms
					}

					updatePidWithRetry()
				})
			}

			const rawStream = this.subprocess.iterable({ from: "all", preserveNewlines: true })

			// Wrap the stream to ensure all chunks are strings (execa can return Uint8Array)
			const stream = (async function* () {
				for await (const chunk of rawStream) {
					yield typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
				}
			})()

			this.terminal.setActiveStream(stream, this.pid)

			for await (const line of stream) {
				if (this.aborted) {
					break
				}

				this.fullOutput += line

				const now = Date.now()

				if (this.isListening && (now - this.lastEmitTime_ms > 500 || this.lastEmitTime_ms === 0)) {
					this.emitRemainingBufferIfListening()
					this.lastEmitTime_ms = now
				}

				this.startHotTimer(line)
			}

			if (this.aborted) {
				let timeoutId: NodeJS.Timeout | undefined

				const kill = new Promise<void>((resolve) => {
					console.log(`[ExecaTerminalProcess#run] SIGKILL -> ${this.pid}`)

					timeoutId = setTimeout(() => {
						try {
							this.subprocess?.kill("SIGKILL")
						} catch (e) {}

						resolve()
					}, 5_000)
				})

				try {
					await Promise.race([this.subprocess, kill])
				} catch (error) {
					console.log(
						`[ExecaTerminalProcess#run] subprocess termination error: ${error instanceof Error ? error.message : String(error)}`,
					)
				}

				if (timeoutId) {
					clearTimeout(timeoutId)
				}
			}

			this.emit("shell_execution_complete", { exitCode: 0 })
		} catch (error) {
			if (error instanceof ExecaError) {
				console.error(`[ExecaTerminalProcess#run] shell execution error: ${error.message}`)
				this.emit("shell_execution_complete", { exitCode: error.exitCode ?? 0, signalName: error.signal })
			} else {
				console.error(
					`[ExecaTerminalProcess#run] shell execution error: ${error instanceof Error ? error.message : String(error)}`,
				)

				this.emit("shell_execution_complete", { exitCode: 1 })
			}
			this.subprocess = undefined
		}

		this.terminal.setActiveStream(undefined)
		this.emitRemainingBufferIfListening()
		this.stopHotTimer()
		this.emit("completed", this.fullOutput)
		this.emit("continue")
		this.subprocess = undefined
	}

	public override continue() {
		this.isListening = false
		this.removeAllListeners("line")
		this.emit("continue")
	}

	public override abort() {
		this.aborted = true

		// Function to perform the kill operations
		const performKill = () => {
			const isWindows = process.platform === "win32"

			// Try to kill using the subprocess object
			if (this.subprocess) {
				try {
					this.subprocess.kill("SIGKILL")
				} catch (e) {
					console.warn(
						`[ExecaTerminalProcess#abort] Failed to kill subprocess: ${e instanceof Error ? e.message : String(e)}`,
					)
				}
			}

			// Kill the stored PID (which should be the actual command after our update)
			if (this.pid) {
				if (isWindows) {
					// On Windows, try taskkill first as it's more reliable
					this.killProcessWindows(this.pid)
				} else {
					try {
						process.kill(this.pid, "SIGKILL")
					} catch (e) {
						console.warn(
							`[ExecaTerminalProcess#abort] Failed to kill process ${this.pid}: ${e instanceof Error ? e.message : String(e)}`,
						)
					}
				}
			}
		}

		// If PID update is in progress, wait for it before killing
		if (this.pidUpdatePromise) {
			this.pidUpdatePromise.then(performKill).catch(() => performKill())
		} else {
			performKill()
		}

		// Continue with the rest of the abort logic
		if (this.pid) {
			// Also check for any child processes
			psTree(this.pid, async (err, children) => {
				if (!err) {
					const pids = children.map((p) => parseInt(p.PID))
					console.error(`[ExecaTerminalProcess#abort] SIGKILL children -> ${pids.join(", ")}`)

					const isWindows = process.platform === "win32"
					for (const pid of pids) {
						if (isWindows) {
							this.killProcessWindows(pid)
						} else {
							try {
								process.kill(pid, "SIGKILL")
							} catch (e) {
								console.warn(
									`[ExecaTerminalProcess#abort] Failed to send SIGKILL to child PID ${pid}: ${e instanceof Error ? e.message : String(e)}`,
								)
							}
						}
					}
				} else {
					console.error(
						`[ExecaTerminalProcess#abort] Failed to get process tree for PID ${this.pid}: ${err.message}`,
					)
				}
			})
		}
	}

	/**
	 * Windows-specific process termination using taskkill
	 */
	private killProcessWindows(pid: number) {
		console.log(`[ExecaTerminalProcess#killProcessWindows] Attempting to terminate process ${pid}`)

		try {
			// Use taskkill with /T (terminate tree) and /F (force) flags
			const result = execSync(`taskkill /pid ${pid} /T /F`, {
				stdio: "pipe",
				encoding: "utf8",
				timeout: 5000, // 5 second timeout
			})
			console.log(`[ExecaTerminalProcess#killProcessWindows] Successfully terminated process ${pid} and its tree`)
			if (result) {
				console.log(`[ExecaTerminalProcess#killProcessWindows] taskkill output: ${result}`)
			}
		} catch (e) {
			const error = e instanceof Error ? e : new Error(String(e))
			console.warn(`[ExecaTerminalProcess#killProcessWindows] taskkill failed for PID ${pid}: ${error.message}`)

			// Check if it's a permission error
			if (error.message.includes("Access is denied") || error.message.includes("Access denied")) {
				console.error(
					`[ExecaTerminalProcess#killProcessWindows] Permission denied when trying to terminate PID ${pid}. This may require administrator privileges.`,
				)
			} else if (error.message.includes("The process") && error.message.includes("not found")) {
				console.log(
					`[ExecaTerminalProcess#killProcessWindows] Process ${pid} was already terminated or not found`,
				)
				return // Process already gone, no need for fallback
			}

			// Fallback to process.kill
			try {
				console.log(`[ExecaTerminalProcess#killProcessWindows] Trying fallback process.kill for PID ${pid}`)
				process.kill(pid, "SIGKILL")
				console.log(`[ExecaTerminalProcess#killProcessWindows] Fallback process.kill succeeded for PID ${pid}`)
			} catch (fallbackError) {
				const fallbackErr = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError))
				console.error(
					`[ExecaTerminalProcess#killProcessWindows] All termination methods failed for PID ${pid}. Final error: ${fallbackErr.message}`,
				)

				// Provide user-friendly error message
				console.error(
					`[ExecaTerminalProcess#killProcessWindows] Unable to terminate process ${pid}. You may need to:`,
					`1. Use Task Manager to manually terminate the process`,
					`2. Run VSCode with administrator privileges`,
					`3. Restart VSCode to clean up orphaned processes`,
				)
			}
		}
	}

	public override hasUnretrievedOutput() {
		return this.lastRetrievedIndex < this.fullOutput.length
	}

	public override getUnretrievedOutput() {
		let output = this.fullOutput.slice(this.lastRetrievedIndex)
		let index = output.lastIndexOf("\n")

		if (index === -1) {
			return ""
		}

		index++
		this.lastRetrievedIndex += index

		// console.log(
		// 	`[ExecaTerminalProcess#getUnretrievedOutput] fullOutput.length=${this.fullOutput.length} lastRetrievedIndex=${this.lastRetrievedIndex}`,
		// 	output.slice(0, index),
		// )

		return output.slice(0, index)
	}

	private emitRemainingBufferIfListening() {
		if (!this.isListening) {
			return
		}

		const output = this.getUnretrievedOutput()

		if (output !== "") {
			this.emit("line", output)
		}
	}
}
