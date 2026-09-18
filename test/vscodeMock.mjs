export function addNativeViewApi(stub) {
  const views = new Map();
  const contexts = new Map();
  const clipboard = [];
  stub.EventEmitter = class {
    listeners = new Set();
    event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  };
  stub.TreeItem = class {
    constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; }
  };
  stub.ThemeIcon = class { constructor(id) { this.id = id; } };
  stub.TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
  stub.window.createTreeView = (id, options) => {
    const visibility = new stub.EventEmitter();
    const view = {
      options, visible: false, onDidChangeVisibility: visibility.event,
      setVisible(visible) { this.visible = visible; visibility.fire({ visible }); },
      async reveal(node, options) { this.revealed = { node, options }; },
      dispose() { visibility.dispose(); },
    };
    views.set(id, view);
    return view;
  };
  stub.commands.executeCommand = async (id, key, value) => {
    if (id === 'setContext') contexts.set(key, value);
  };
  stub.env.clipboard = { writeText: async text => { clipboard.push(text); } };
  return { views, contexts, clipboard };
}
