import { PluginSettingTab, App, Setting } from "obsidian";
import Main from "./main";

export class VirtualFSPluginSettingsTab extends PluginSettingTab {
	constructor(
		app: App,
		override plugin: Main,
	) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Cache management")
			.setDesc("Manage vault cache")
			.addButton((button) =>
				button
					.setButtonText("Clear cache")
					.setCta()
					.onClick(() => {
						void this.plugin.fsCache?.clearAll().then(() => {
							new Notice("Cleared cache!");
						});
					}),
			);
	}
}
