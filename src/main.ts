/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
	CapacitorAdapter,
	FileSystemAdapter,
	Reference,
	TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";

import { initialize } from "./OriginalMetadataCache";
import { CacheTreeFolder, FSCache } from "./FSCache";
import PluginWithSettings from "../obsidian-reusables/src/PluginWithSettings";
import { getParentPath } from "../obsidian-reusables/src/indexFiles";
import { VirtualFSPluginSettingsTab } from "./settings";
import { CustomArrayDictImpl } from "obsidian-typings/src/obsidian/implementations/Classes/CustomArrayDictImpl";

type ReadDir = (p: string) => Promise<
	{
		name: string;
		type: "file" | "folder";
		ctime: number;
		mtime: number;
		size: number;
	}[]
>;

export default class Main extends PluginWithSettings({}) {
	override async onload() {
		await this.initSettings(VirtualFSPluginSettingsTab);

		// eslint-disable-next-line @typescript-eslint/no-empty-function
		this.app.metadataCache.initialize = async () => {};

		this.patchNodeFSAdapter();
		this.patchCapacitorFSAdapter();
	}

	private patchCapacitorFSAdapter() {
		this.registerPatch(CapacitorAdapter.prototype, {
			watchAndList(_, plugin) {
				return async function () {
					const readDir = async (p: string) => {
						const children = await this.fs.readdir(p);
						return children.map((v) => ({
							name: v.name,
							type:
								v.type === "directory"
									? ("folder" as const)
									: ("file" as const),
							ctime: v.ctime ?? 0,
							mtime: v.mtime ?? 0,
							size: v.size ?? 0,
						}));
					};
					await plugin.lazyLoad(readDir);
				};
			},
		});
	}

	private patchNodeFSAdapter() {
		this.registerPatch(FileSystemAdapter.prototype, {
			listAll(_, plugin) {
				return async function () {
					const readDir = async (p: string) => {
						const children = await this.fsPromises.readdir(p, {
							withFileTypes: true,
						});
						const promises = children.map(async (v) => {
							const stats = await this.fsPromises.stat(
								p + "/" + v.name,
							);
							return {
								name: v.name,
								type: v.isDirectory()
									? ("folder" as const)
									: ("file" as const),
								ctime: stats.ctime.valueOf(),
								mtime: stats.mtime.valueOf(),
								size: stats.size,
							};
						});
						return Promise.all(promises);
					};
					await plugin.lazyLoad(readDir);
				};
			},
		});
	}

	fsCache: FSCache | undefined;
	setupListenersForCache = (fsCache: FSCache) => {
		const createFileInFSCache = (file: TAbstractFile) => {
			if (file.parent)
				fsCache.addItem(
					file.parent.path,
					file instanceof TFile
						? {
								size: file.stat.size,
								mtime: file.stat.mtime,
								ctime: file.stat.ctime,
							}
						: {
								children: {},
							},
					file.name,
				);
		};
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				createFileInFSCache(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file.path !== "/")
					fsCache.deleteItem(getParentPath(file.path)!, file.name);
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				const old = fsCache.getItem(oldPath);
				const parentpath =
					oldPath.split("/").slice(0, -1).join("/") || "/";
				const name = oldPath.split("/").at(-1)!;
				fsCache.deleteItem(parentpath, name);
				if (old)
					fsCache.addItem(file.parent?.path ?? "/", old, file.name);
				else createFileInFSCache(file);
			}),
		);
	};

	private reconcileNode = (node: Node) => {
		this.app.vault.adapter.files[node.path] = {
			type: "size" in node ? "file" : "folder",
			realpath: node.path,
		};
		const existing = this.app.vault.fileMap[node.path];
		if (existing) {
			if ("size" in node) {
				if (existing instanceof TFolder)
					this.app.vault.onChange("folder-removed", node.path);
				else return;
			} else {
				if (existing instanceof TFile)
					this.app.vault.onChange("file-removed", node.path);
				else if (existing instanceof TFolder) {
					const newByName = new Set(node.children.map((v) => v.name));
					for (const child of existing.children) {
						const wasDeleted = !newByName.has(child.name);
						const isVirtual =
							child instanceof TFile && child.extension === "dir";
						if (wasDeleted && !isVirtual)
							this.app.vault.onChange("file-removed", child.path);
					}
					return;
				}
			}
		}
		if ("size" in node) {
			this.app.vault.onChange("file-created", node.path, undefined, node);
			const file = this.app.vault.fileMap[node.path];

			if (file instanceof TFile)
				this.app.metadataCache.uniqueFileLookup.add(
					file.name.toLowerCase(),
					file,
				);
		} else this.app.vault.onChange("folder-created", node.path);
	};

	private async lazyLoad(readdir: ReadDir) {
		const adapter = this.app.vault.adapter;

		const fsCache = new FSCache(adapter.basePath);
		this.fsCache = fsCache;
		console.time("reading cache");
		const wasInitialised = await fsCache.init();
		const tree = await fsCache.getTree();
		console.timeEnd("reading cache");
		const wasEmpty =
			wasInitialised || Object.keys(tree.children).length === 0;

		const otherHandlers = this.app.vault._;
		this.app.vault._ = {};

		console.time("applying cache");
		this.visitCachedNodes(tree, this.reconcileNode, "/");
		console.timeEnd("applying cache");
		this.app.vault._ = otherHandlers;

		this.setupListenersForCache(fsCache);
		const reconcilePromise = this.visitRealNodes(
			"/",
			this.reconcileNode,
			readdir,
			wasEmpty ? undefined : 10,
		);
		const updateMetadataCache = async () => {
			console.time("metadata");
			await initialize.bind(this.app.metadataCache)();
			console.timeEnd("metadata");
		};

		const updateFile = (file: TFile) => {
			for (const [target] of file.links ?? []) {
				target.backlinks?.delete(file);
			}
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache) {
				file.links ??= new Map();
				for (const link of [
					...(cache.links ?? []),
					...(cache.frontmatterLinks ?? []),
				]) {
					const target = this.app.metadataCache.getFirstLinkpathDest(
						link.link,
						file.path,
					);
					if (!target) continue;
					target.backlinks ??= new Map<TFile, Reference[]>();
					const refs = target.backlinks.get(file) ?? [];
					refs.push(link);
					target.backlinks.set(file, refs);

					const outRefs = file.links.get(target) ?? [];
					outRefs.push(link);
					file.links.set(target, outRefs);
				}
			}
		};
		const updateBacklinks = async () => {
			const notice = new Notice("Starting filling backlinks", 100000);
			console.time("backlinks");
			const files = this.app.vault.getFiles();
			for (let i = 0; i < files.length; i++) {
				const file = files[i];
				if (file) updateFile(file);
				if (i % 100 === 0) await new Promise((r) => setTimeout(r, 1));
			}
			console.timeEnd("backlinks");
			notice.setMessage("Finished filling backlinks");
			setTimeout(() => {
				notice.hide();
			}, 2000);
		};
		const bindFileWatchers =
			adapter instanceof FileSystemAdapter
				? async () => {
						const notice = new Notice(
							"Starting setting watches",
							100000,
						);
						console.time("watches");
						const files = Object.keys(adapter.files);
						for (let i = 0; i < files.length; i++) {
							const file = files[i]!;
							await adapter.startWatchPath(file);
							if (i % 20 === 0)
								await new Promise((r) => setTimeout(r, 20));
						}
						console.timeEnd("watches");
						notice.setMessage("Finished setting watches");
						setTimeout(() => {
							notice.hide();
						}, 2000);
					}
				: async () => {
						/* file watchers are not supported by the adapter */
					};
		if (wasEmpty) {
			console.time("filling cache");
			await reconcilePromise;
			console.timeEnd("filling cache");
			void updateMetadataCache()
				.then(updateBacklinks)
				.then(bindFileWatchers);
		} else {
			console.time("updating cache");
			void updateBacklinks();
			void reconcilePromise
				.then(() => {
					console.timeEnd("updating cache");
				})
				.then(updateMetadataCache)
				// .then(updateBacklinks)
				.then(bindFileWatchers);
		}

		this.app.metadataCache.on("resolve", (file) => {
			updateFile(file);
		});
		this.app.metadataCache.on("changed", (file) => {
			updateFile(file);
		});
		this.app.vault.on("delete", (file) => {
			if (file instanceof TFile)
				for (const [target] of file.links ?? []) {
					target.backlinks?.delete(file);
				}
		});

		this.registerPatch(this.app.metadataCache, {
			getBacklinksForFile() {
				return (file) => {
					const dict = new CustomArrayDictImpl<Reference>();
					dict.data = new Map<string, Reference[]>(
						[...(file.backlinks?.entries() ?? [])].map(([k, v]) => [
							k.path,
							v,
						]),
					);
					return dict;
				};
			},
		});

		return fsCache;
	}
	private visitCachedNodes(
		tree: CacheTreeFolder,
		visitor: (node: Node) => void,
		path: string,
	) {
		visitor({
			type: "folder",
			path,
			children: Object.entries(tree.children).map(([name, v]) =>
				"children" in v
					? { type: "folder", name }
					: { type: "file", name },
			),
		});
		for (const [name, child] of Object.entries(tree.children)) {
			const nextPath = path === "/" ? name : `${path}/${name}`;
			if ("children" in child) {
				this.visitCachedNodes(child, visitor, nextPath);
			} else {
				visitor({
					type: "file",
					path: nextPath,
					ctime: child.ctime,
					mtime: child.mtime,
					size: child.size,
				});
			}
		}
	}

	async visitRealNodes(
		p: string,
		visitor: (node: Node) => void,
		readdir: ReadDir,
		timeout?: number,
	) {
		const base = this.app.vault.adapter.basePath;
		const fullPath = p === "/" ? base : base + "/" + p;
		const children = await readdir(fullPath);
		if (timeout !== undefined)
			await new Promise((r) => setTimeout(r, timeout));

		visitor({ type: "folder", path: p, children });
		for (const c of children) {
			const nextPath = p === "/" ? c.name : `${p}/${c.name}`;
			if (c.name.startsWith(".")) continue;
			if (c.type === "folder") {
				await this.visitRealNodes(nextPath, visitor, readdir);
			} else {
				visitor({
					type: "file",
					path: nextPath,
					ctime: c.ctime,
					mtime: c.mtime,
					size: c.size,
				});
			}
		}
	}
}

declare module "obsidian" {
	interface TFile extends TAbstractFile {
		backlinks?: Map<TFile, Reference[]>;
		links?: Map<TFile, Reference[]>;
	}
}
type Node =
	| {
			type: "folder";
			path: string;
			children: {
				name: string;
				type: "file" | "folder";
				ctime?: number;
				mtime?: number;
				size?: number;
			}[];
	  }
	| {
			type: "file";
			path: string;
			mtime: number;
			ctime: number;
			size: number;
	  };
