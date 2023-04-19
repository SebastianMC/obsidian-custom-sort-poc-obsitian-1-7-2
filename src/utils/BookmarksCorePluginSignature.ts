import {App, InstalledPlugin, Plugin, PluginInstance, TAbstractFile, TFolder} from "obsidian";
import {lastPathComponent} from "./utils";

const BookmarksPlugin_getBookmarks_methodName = 'getBookmarks'

const BookmarksPlugin_items_collectionName = 'items'

type Path = string

  // Only relevant types of bookmarked items considered here
  //      The full set of types also includes 'search', canvas, graph, maybe more to come
type BookmarkedItem = BookmarkedFile | BookmarkedFolder | BookmarkedGroup

// Either a file, a folder or header/block inside a file
interface BookmarkWithPath {
    path: Path
}

interface BookmarkedFile {
    type: 'file'
    path: Path
    subpath?: string  // Anchor within the file (heading and/or block ref)
    title?: string
    ctime: number
}

interface BookmarkedFolder {
    type: 'folder'
    path: Path
    title?: string
    ctime: number
}

interface BookmarkedGroup {
    type: 'group'
    items: Array<BookmarkedItem>
    title?: string
    ctime: number
}

export type BookmarkedItemPath = string

export interface OrderedBookmarkedItem {
    file: boolean
    folder: boolean
    group: boolean
    path: BookmarkedItemPath
    order: number
}

interface OrderedBookmarks {
    [key: BookmarkedItemPath]: OrderedBookmarkedItem
}

export interface Bookmarks_PluginInstance extends PluginInstance {
    [BookmarksPlugin_getBookmarks_methodName]: () => Array<BookmarkedItem> | undefined
    [BookmarksPlugin_items_collectionName]: Array<BookmarkedItem>
    saveData(): void
}

let bookmarksCache: OrderedBookmarks | undefined = undefined
let bookmarksCacheTimestamp: number | undefined = undefined

const CacheExpirationMilis = 1000  // One second seems to be reasonable

export const invalidateExpiredBookmarksCache = (force?: boolean): void => {
    if (bookmarksCache) {
        let flush: boolean = true
        if (!force && !!bookmarksCacheTimestamp) {
            if (Date.now() - CacheExpirationMilis <= bookmarksCacheTimestamp) {
                flush = false
            }
        }
        if (flush) {
            bookmarksCache = undefined
            bookmarksCacheTimestamp = undefined
        }
    }
}

export const BookmarksCorePluginId: string = 'bookmarks'

export const getBookmarksPlugin = (app?: App): Bookmarks_PluginInstance | undefined => {
    invalidateExpiredBookmarksCache()
    const bookmarksPlugin: InstalledPlugin | undefined = app?.internalPlugins?.getPluginById(BookmarksCorePluginId)
    console.log(bookmarksPlugin)
    const bookmarks = (bookmarksPlugin?.instance as any) ?.['getBookmarks']()
    console.log(bookmarks)
    if (bookmarksPlugin && bookmarksPlugin.enabled && bookmarksPlugin.instance) {
        const bookmarksPluginInstance: Bookmarks_PluginInstance = bookmarksPlugin.instance as Bookmarks_PluginInstance
        // defensive programming, in case Obsidian changes its internal APIs
        if (typeof bookmarksPluginInstance?.[BookmarksPlugin_getBookmarks_methodName] === 'function') {
            return bookmarksPluginInstance
        }
    }
}

type TraverseCallback = (item: BookmarkedItem, parentsGroupsPath: string) => boolean | void

const traverseBookmarksCollection = (items: Array<BookmarkedItem>, callback: TraverseCallback) => {
    const recursiveTraversal = (collection: Array<BookmarkedItem>, groupsPath: string) => {
        for (let idx = 0, collectionRef = collection; idx < collectionRef.length; idx++) {
            const item = collectionRef[idx];
            if (callback(item, groupsPath)) return;
            if ('group' === item.type) recursiveTraversal(item.items, `${groupsPath}${groupsPath?'/':''}${item.title}`);
        }
    };
    recursiveTraversal(items, '');
}

const getOrderedBookmarks = (plugin: Bookmarks_PluginInstance, bookmarksGroupName?: string): OrderedBookmarks | undefined => {
    console.log(`Populating bookmarks cache with group scope ${bookmarksGroupName}`)
    let bookmarks: Array<BookmarkedItem> | undefined = plugin?.[BookmarksPlugin_getBookmarks_methodName]()
    if (bookmarks) {
        if (bookmarksGroupName) {
            const bookmarksGroup: BookmarkedGroup|undefined = bookmarks.find(
                (item) => item.type === 'group' && item.title === bookmarksGroupName) as BookmarkedGroup
            bookmarks = bookmarksGroup ? bookmarksGroup.items : undefined
        }
        if (bookmarks) {
            const orderedBookmarks: OrderedBookmarks = {}
            let order: number = 0
            const consumeItem = (item: BookmarkedItem, parentGroupsPath: string) => {
                const isFile: boolean = item.type === 'file'
                const isAnchor: boolean = isFile && !!(item as BookmarkedFile).subpath
                const isFolder: boolean = item.type === 'folder'
                const isGroup: boolean = item.type === 'group'
                if ((isFile && !isAnchor) || isFolder || isGroup) {
                    const pathOfGroup: string = `${parentGroupsPath}${parentGroupsPath?'/':''}${item.title}`
                    const path = isGroup ? pathOfGroup : (item as BookmarkWithPath).path
                    // Consume only the first occurrence of a path in bookmarks, even if many duplicates can exist
                    const alreadyConsumed = orderedBookmarks[path]
                    if (!alreadyConsumed) {
                        orderedBookmarks[path] = {
                            path: path,
                            order: order++,
                            file: isFile,
                            folder: isFile,
                            group: isGroup
                        }
                    }
                }
            }
            traverseBookmarksCollection(bookmarks, consumeItem)
            return orderedBookmarks
        }
    }
}

// Result:
//    undefined ==> item not found in bookmarks
//    > 0 ==> item found in bookmarks at returned position
// Intentionally not returning 0 to allow simple syntax of processing the result
export const determineBookmarkOrder = (path: string, plugin: Bookmarks_PluginInstance, bookmarksGroup?: string): number | undefined => {
    if (!bookmarksCache) {
        bookmarksCache = getOrderedBookmarks(plugin, bookmarksGroup)
        bookmarksCacheTimestamp = Date.now()
    }

    const bookmarkedItemPosition: number | undefined = bookmarksCache?.[path]?.order

    return (bookmarkedItemPosition !== undefined && bookmarkedItemPosition >= 0) ? (bookmarkedItemPosition + 1) : undefined
}

// EXPERIMENTAL - operates on internal structures of core Bookmarks plugin

const createBookmarkFileEntry = (path: string): BookmarkedFile => {
    return { type: "file", ctime: Date.now(), path: path }
}

const createBookmarkGroupEntry = (title: string): BookmarkedGroup => {
    return { type: "group", ctime: Date.now(), items: [], title: title }
}

export const bookmarkFolderItem = (item: TAbstractFile, plugin: Bookmarks_PluginInstance, bookmarksGroup?: string) => {
    bookmarkSiblings([item], plugin, bookmarksGroup)
}

export const bookmarkSiblings = (siblings: Array<TAbstractFile>, plugin: Bookmarks_PluginInstance, bookmarksGroup?: string) => {
    let items = plugin[BookmarksPlugin_items_collectionName]

    if (siblings.length === 0) return // for sanity

    const parentPathComponents: Array<string> = siblings[0].path.split('/')!
    parentPathComponents.pop()

    if (bookmarksGroup) {
        parentPathComponents.unshift(bookmarksGroup)
    }

    parentPathComponents.forEach((pathSegment) => {
        let group: BookmarkedGroup|undefined = items.find((it) => it.type === 'group' && it.title === pathSegment) as BookmarkedGroup
        if (!group) {
            group = createBookmarkGroupEntry(pathSegment)
            items.push(group)
        }
        items = group.items
    })

    siblings.forEach((aSibling) => {
        const siblingName = lastPathComponent(aSibling.path)
        if (!items.find((it) =>
            ((it.type === 'folder' || it.type === 'file') && it.path === aSibling.path) ||
            (it.type === 'group' && it.title === siblingName))) {
            const newEntry: BookmarkedItem = (aSibling instanceof TFolder) ? createBookmarkGroupEntry(siblingName) : createBookmarkFileEntry(aSibling.path)
            items.push(newEntry)
        }
    });
}

export const saveDataAndUpdateBookmarkViews = (plugin: Bookmarks_PluginInstance, app: App) => {
    plugin.saveData()
    const bookmarksLeafs = app.workspace.getLeavesOfType('bookmarks')
    bookmarksLeafs?.forEach((leaf) => {
        (leaf.view as any)?.update?.()
    })
}
