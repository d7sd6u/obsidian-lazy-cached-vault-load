/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
	CapacitorAdapter,
	FileSystemAdapter,
	TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";

import { initialize } from "./OriginalMetadataCache";
import { CacheTreeFolder, FSCache } from "./FSCache";
import PluginWithSettings from "../obsidian-reusables/src/PluginWithSettings";
import { getParentPath } from "../obsidian-reusables/src/indexFiles";
import { VirtualFSPluginSettingsTab } from "./settings";

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
					for (const child of existing.children) {
						const wasDeleted = !node.children.find(
							(c) => c.name === child.name,
						);
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
			if (this.app.vault.adapter instanceof FileSystemAdapter) {
				void this.app.vault.adapter.startWatchPath(node.path);
			}
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
		const isEmpty = await fsCache.init();
		const tree = await fsCache.getTree();

		const otherHandlers = this.app.vault._;
		this.app.vault._ = {};

		this.visitCachedNodes(tree, this.reconcileNode, "/");

		this.app.vault._ = otherHandlers;

		this.setupListenersForCache(fsCache);
		const reconcilePromise = this.visitRealNodes(
			"/",
			this.reconcileNode,
			readdir,
		);
		const updateMetadataCache = initialize.bind(this.app.metadataCache);

		if (isEmpty) {
			await reconcilePromise;
			void updateMetadataCache();
		} else {
			void reconcilePromise.then(updateMetadataCache);
		}

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
	) {
		const base = this.app.vault.adapter.basePath;
		const fullPath = p === "/" ? base : base + "/" + p;
		const children = await readdir(fullPath);

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
