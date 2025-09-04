let activeWorkspacePath: string | undefined

export function setActiveWorkspacePath(path: string | undefined): void {
	activeWorkspacePath = path
}

export function getActiveWorkspacePath(): string | undefined {
	return activeWorkspacePath
}
