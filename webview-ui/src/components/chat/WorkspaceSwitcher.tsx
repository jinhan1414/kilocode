import React from "react"
import { vscode } from "../../utils/vscode"
import { SelectDropdown, DropdownOptionType } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"

interface Workspace {
	name: string
	path: string
}

interface WorkspaceSwitcherProps {
	workspaceFolders: Workspace[]
	activeWorkspacePath?: string
}

const WorkspaceSwitcher: React.FC<WorkspaceSwitcherProps> = ({ workspaceFolders, activeWorkspacePath }) => {
	const { t } = useAppTranslation()

	const handleSwitch = (path: string) => {
		vscode.postMessage({
			type: "switchWorkspace",
			path,
		})
	}

	const activeWorkspace = workspaceFolders.find((folder) => folder.path === activeWorkspacePath)

	return (
		<div className={cn("flex-1", "min-w-[120px]", "overflow-hidden")}>
			<SelectDropdown
				value={activeWorkspacePath || ""}
				title={t("chat:switchWorkspace")}
				placeholder={activeWorkspace?.name || t("chat:switchWorkspace")}
				options={workspaceFolders.map((folder) => ({
					value: folder.path,
					label: folder.name,
					type: DropdownOptionType.ITEM,
				}))}
				onChange={handleSwitch}
				triggerClassName={cn(
					"w-full text-ellipsis overflow-hidden",
					"bg-[var(--background)] border-[var(--vscode-input-border)] hover:bg-[var(--color-vscode-list-hoverBackground)]",
				)}
			/>
		</div>
	)
}

export default WorkspaceSwitcher
