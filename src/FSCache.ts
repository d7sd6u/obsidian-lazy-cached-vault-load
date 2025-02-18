import { debounce } from "obsidian";

/* eslint-disable @typescript-eslint/prefer-promise-reject-errors */
export class FSCache {
	private dbName: string;
	private storeName: string;
	private db: IDBDatabase | null = null;

	constructor(vaultPath: string) {
		this.dbName = "FSCache-" + vaultPath;
		this.storeName = "tree";
	}

	async init(): Promise<boolean> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.dbName, 4);
			let isUpgraded = false;

			request.onupgradeneeded = (event) => {
				isUpgraded = true;
				const db = (event.target as IDBOpenDBRequest).result;
				if (db.objectStoreNames.contains(this.storeName)) {
					db.deleteObjectStore(this.storeName);
				}
				db.createObjectStore(this.storeName, {
					keyPath: "key" satisfies keyof CacheTreeFolder,
				});
			};

			request.onsuccess = () => {
				this.db = request.result;
				if (isUpgraded) {
					void this.clearAll().then(() => {
						resolve(true);
					});
				} else
					void this.getTree().then((t) => {
						resolve(Object.keys(t.children).length === 0);
					});
			};

			request.onerror = () => {
				reject(request.error);
			};
		});
	}

	private getStore(mode: IDBTransactionMode): IDBObjectStore {
		if (!this.db) throw new Error("Database not initialized");
		return this.db
			.transaction(this.storeName, mode)
			.objectStore(this.storeName);
	}

	flushEdits = debounce(
		(tree: CacheTreeFolder) => {
			return new Promise<void>((resolve, reject) => {
				const request = this.getStore("readwrite").put(tree);
				request.onsuccess = () => {
					new Notice("Updated cache");
					resolve();
				};
				request.onerror = () => {
					reject(request.error);
				};
			});
		},
		1000,
		true,
	);

	private getByPath(
		path: string,
	): CacheTreeFile | CacheTreeFolder | undefined {
		if (path === "/") return this.inMemoryTree;

		let currentFolder: CacheTreeFolder | CacheTreeFile | undefined =
			this.inMemoryTree;
		for (const section of path.split("/")) {
			if (!("children" in currentFolder)) return undefined;
			const next: CacheTreeFile | CacheTreeFolder | undefined =
				currentFolder.children[section];
			if (!next) return undefined;
			currentFolder = next;
		}
		return currentFolder;
	}

	addItem(
		parentPath: string,
		file: CacheTreeFile | CacheTreeFolder,
		name: string,
	) {
		const currentFolder = this.getByPath(parentPath);
		if (
			!currentFolder ||
			!("children" in currentFolder) ||
			name in currentFolder.children
		)
			return;
		currentFolder.children[name] = file;
		this.changeTree(this.inMemoryTree);
	}
	getItem(path: string) {
		return this.getByPath(path);
	}

	async getTree(): Promise<CacheTreeFolder> {
		const tree = await new Promise<CacheTreeFolder>((resolve, reject) => {
			const request = this.getStore("readonly").get("tree");
			request.onsuccess = () => {
				resolve(request.result as CacheTreeFolder);
			};
			request.onerror = () => {
				reject(request.error);
			};
		});
		this.inMemoryTree = tree;
		return tree;
	}

	private changeTree(tree: CacheTreeFolder) {
		this.flushEdits(tree);
	}

	updateItem(parentPath: string, file: CacheTreeFile, name: string) {
		const currentFolder = this.getByPath(parentPath);
		if (
			!currentFolder ||
			!("children" in currentFolder) ||
			!(name in currentFolder.children)
		)
			return;
		currentFolder.children[name] = file;
		this.changeTree(this.inMemoryTree);
	}

	inMemoryTree: CacheTreeFolder = emptyTree();

	deleteItem(parentPath: string, name: string) {
		const currentFolder = this.getByPath(parentPath);
		if (
			!currentFolder ||
			!("children" in currentFolder) ||
			!(name in currentFolder.children)
		)
			return;
		// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
		delete currentFolder.children[name];
		this.changeTree(this.inMemoryTree);
	}

	async clearAll(): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = this.getStore("readwrite").put(emptyTree());
			request.onsuccess = () => {
				resolve();
			};
			request.onerror = () => {
				reject(request.error);
			};
		});
	}
}

function emptyTree(): CacheTreeFolder {
	return { key: "tree", children: {} };
}

export interface CacheTreeFolder {
	key?: "tree";
	children: Record<string, CacheTreeFile | CacheTreeFolder>;
}

export interface CacheTreeFile {
	size: number;
	ctime: number;
	mtime: number;
}
