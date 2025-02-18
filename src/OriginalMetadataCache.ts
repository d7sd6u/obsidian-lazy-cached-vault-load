/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable no-prototype-builtins */
import { MetadataCache, Platform } from "obsidian";

export async function initialize(this: MetadataCache) {
	const uniqueFiles = Object.fromEntries(
		this.app.vault.getFiles().map((v) => [v.path, v]),
	);
	await this._preload();

	const fileCache = this.fileCache;
	const metadataCache = this.metadataCache;
	setInterval(this.cleanupDeletedCache.bind(this), 600000); // 10 minutes

	let i = 0;
	const batchSize = 50;
	const pauseTime = 100;
	const notice = new Notice("Starting cache updating");
	for (const path in fileCache) {
		if (!path.endsWith(".md")) continue;
		if (fileCache.hasOwnProperty(path)) {
			const file = uniqueFiles[path];
			const cachedData = fileCache[path]!;

			if (file) {
				if (metadataCache.hasOwnProperty(cachedData.hash)) {
					if (
						Platform.isAndroidApp &&
						file.stat.mtime !== cachedData.mtime &&
						cachedData.mtime % 1000 === 0 &&
						Math.floor(file.stat.mtime / 1000) * 1000 ===
							cachedData.mtime
					) {
						cachedData.mtime = file.stat.mtime;
						this.saveFileCache(path, cachedData);
					}

					if (
						file.stat.mtime !== cachedData.mtime ||
						file.stat.size !== cachedData.size
					) {
						notice.setMessage(`Computing ${i} - change`);
						await this.computeFileMetadataAsync(file);
						i++;
						if (i % batchSize === 0)
							await new Promise((r) => setTimeout(r, pauseTime));
					} else {
						this.linkResolverQueue?.add(file);
					}
				} else {
					notice.setMessage(`Computing ${i} - insert`);
					await this.computeFileMetadataAsync(file);
					i++;
					if (i % batchSize === 0)
						await new Promise((r) => setTimeout(r, pauseTime));
				}
			} else {
				notice.setMessage(`Computing ${i} - delete`);
				this.deletePath(path);
			}
		}
	}

	for (const path in uniqueFiles) {
		if (
			uniqueFiles.hasOwnProperty(path) &&
			!fileCache.hasOwnProperty(path)
		) {
			notice.setMessage(`Computing ${i} - create`);
			await this.computeFileMetadataAsync(uniqueFiles[path]!);
			i++;
			if (i % batchSize === 0)
				await new Promise((r) => setTimeout(r, pauseTime));
		}
	}

	this.initialized = true;
	this.watchVaultChanges();
	this.updateUserIgnoreFilters();
	this.trigger("finished");

	setTimeout(() => {
		this.cleanupDeletedCache();
	}, 60000); // 1 minute
}
