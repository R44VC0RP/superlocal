import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import "./mail-motion.css";

type Change = "remove" | "undo" | "search" | "switch" | "return";
type Options = {
  rowsKey: string;
  viewKey: string;
  highlight: number;
  instantHighlight?: boolean;
  focused?: boolean;
};
type Item = {
  key: string;
  id?: string;
  node: HTMLElement;
  rect: DOMRect;
  top: number;
  naturalTop: number;
  clone: HTMLElement | null;
};
type Snapshot = {
  root: HTMLDivElement;
  items: Map<string, Item>;
  end: number;
};
type Ghost = { node: HTMLElement; top: number; animation: Animation | null };
type Batch = {
  ids: Set<string>;
  offsets: Map<string, number>;
  height: number;
  ghosts: Map<string, Ghost>;
  timer: ReturnType<typeof setTimeout>;
};
type Scene = {
  root: HTMLDivElement;
  owner: HTMLDivElement;
  style: HTMLStyleElement;
  background: HTMLDivElement;
  bar: HTMLDivElement;
  ink: HTMLDivElement;
  clip: HTMLDivElement;
  end: HTMLDivElement;
  dispose: () => void;
};

export function useMailMotion(
  list: RefObject<HTMLDivElement | null>,
  options: Options,
) {
  const scope = useId();
  const owner = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene | null>(null);
  const latest = useRef(options);
  const previous = useRef<{ rowsKey: string; viewKey: string } | null>(null);
  const prepared = useRef<{ reason: Change; snapshot: Snapshot | null; ids?: Set<string> } | null>(
    null,
  );
  const finishFrame = useRef<number | null>(null);
  const batches = useRef(new Set<Batch>());
  const order = useRef(new Map<string, number>());
  const [hasExits, setHasExits] = useState(false);

  function reduced() {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function offset(key: string) {
    let y = 0;
    for (const batch of batches.current) y += batch.offsets.get(key) || 0;
    return y;
  }

  function capture(
    root: HTMLDivElement,
    cloneVisible = false,
    held = true,
  ): Snapshot {
    const bounds = root.getBoundingClientRect();
    const origin = bounds.top + root.clientTop - root.scrollTop;
    const headings = new Map<string, number>();
    const items = new Map<string, Item>();
    const padding = getComputedStyle(root);
    let end = parseFloat(padding.paddingTop) || 0;
    for (const node of root.querySelectorAll<HTMLElement>(
      ":scope > .mail-row[data-motion-id], :scope > .mail-group-heading",
    )) {
      const id = node.dataset.motionId;
      const label = node.textContent || "";
      const occurrence = headings.get(label) || 0;
      if (!id) headings.set(label, occurrence + 1);
      const key = id ? `row:${id}` : `heading:${label}:${occurrence}`;
      const rect = node.getBoundingClientRect();
      const top = rect.top - origin;
      const naturalTop = top - (held ? offset(key) : 0);
      const visible =
        rect.bottom > Math.max(bounds.top + root.clientTop, 0) &&
        rect.top <
          Math.min(
            bounds.top + root.clientTop + root.clientHeight,
            innerHeight,
          ) &&
        rect.right > Math.max(bounds.left, 0) &&
        rect.left < Math.min(bounds.right, innerWidth);
      items.set(key, {
        key,
        id,
        node,
        rect,
        top,
        naturalTop,
        clone:
          cloneVisible && id && visible
            ? (node.cloneNode(true) as HTMLElement)
            : null,
      });
      end = Math.max(end, naturalTop + rect.height);
    }
    return { root, items, end: end + (parseFloat(padding.paddingBottom) || 0) };
  }

  function syncHighlight(snap = false, returning = false) {
    const current = scene.current;
    if (!current) return;
    const { root, background, bar, ink } = current;
    const active = root.querySelector<HTMLElement>(
      ':scope > .mail-row[data-motion-id][data-highlighted="true"]',
    );
    const instant = snap || reduced();
    for (const node of [background, bar, ink])
      node.style.transition = instant ? "none" : "";
    const visible = !!active && latest.current.focused !== false;
    if (active) {
      const bounds = root.getBoundingClientRect();
      const rect = active.getBoundingClientRect();
      const top = rect.top - bounds.top - root.clientTop + root.scrollTop;
      for (const node of [background, bar]) {
        Object.assign(node.style, {
          left: `${rect.left - bounds.left - root.clientLeft + root.scrollLeft}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          transform: `translateY(${top}px)`,
        });
      }
    }
    if (returning && visible && !instant) {
      ink.style.transition = "none";
      ink.style.opacity = "0";
      ink.style.transform = "translateX(30px) scaleY(.8)";
      ink.getBoundingClientRect();
      ink.style.transition = "";
    }
    background.style.opacity =
      visible && !active?.classList.contains("selected") ? "1" : "0";
    ink.style.opacity = visible ? "1" : "0";
    ink.style.transform = visible
      ? "translateX(0) scaleY(1)"
      : "translateX(30px) scaleY(.8)";
  }

  function placeGhosts() {
    const current = scene.current;
    if (!current) return;
    const { root, clip } = current;
    const bounds = root.getBoundingClientRect();
    Object.assign(clip.style, {
      left: `${bounds.left + root.clientLeft}px`,
      top: `${bounds.top + root.clientTop}px`,
      width: `${root.clientWidth}px`,
      height: `${root.clientHeight}px`,
    });
    for (const batch of batches.current) {
      for (const ghost of batch.ghosts.values()) {
        ghost.node.style.top = `${ghost.top - root.scrollTop}px`;
      }
    }
  }

  function applyHolds(snapshot?: Snapshot) {
    const current = scene.current;
    if (!current) return;
    // Only this empty React-owned layer is mutated. Its scoped stylesheet holds
    // real rows in place without moving, wrapping, or replacing React's nodes.
    current.style.textContent = "";
    if (!batches.current.size) {
      current.end.style.display = "none";
      return;
    }
    const natural = snapshot || capture(current.root, false, false);
    const selector = `.animated-mail-list:has(> [data-mail-motion=${JSON.stringify(scope)}])`;
    const indices = new Map(
      Array.from(current.root.children).map((node, i) => [node, i + 1]),
    );
    const rules: string[] = [];
    const groups: { first: number; last: number; y: number }[] = [];
    for (const item of natural.items.values()) {
      const y = offset(item.key);
      const index = indices.get(item.node)!;
      if (!y) continue;
      const group = groups.at(-1);
      if (group && group.last + 1 === index && group.y === y)
        group.last = index;
      else groups.push({ first: index, last: index, y });
    }
    for (const group of groups) {
      rules.push(
        `${selector} > :nth-child(n+${group.first}):nth-child(-n+${group.last}) { translate: 0 ${group.y}px !important; transition: none !important; }`,
      );
    }
    current.style.textContent = rules.join("\n");
    const height = [...batches.current].reduce(
      (total, batch) => total + batch.height,
      0,
    );
    current.end.style.display = "block";
    current.end.style.top = `${Math.max(0, natural.end + height - 1)}px`;
    placeGhosts();
  }

  function release(batch: Batch, collapse: boolean) {
    clearTimeout(batch.timer);
    batches.current.delete(batch);
    for (const ghost of batch.ghosts.values()) {
      if (ghost.animation) {
        ghost.animation.onfinish = null;
        ghost.animation.cancel();
      }
      ghost.node.remove();
    }
    if (collapse) {
      for (const pending of batches.current) {
        for (const [key, ghost] of pending.ghosts)
          ghost.top -= batch.offsets.get(key) || 0;
      }
    }
  }

  function clear(notify = true) {
    if (finishFrame.current !== null) cancelAnimationFrame(finishFrame.current);
    finishFrame.current = null;
    prepared.current = null;
    for (const batch of [...batches.current]) release(batch, false);
    order.current.clear();
    if (scene.current) {
      scene.current.style.textContent = "";
      scene.current.end.style.display = "none";
    }
    if (notify) setHasExits(false);
  }

  function cancel() {
    clear();
    syncHighlight(true);
  }

  function prepare(reason: Change, ids?: string[]) {
    if (finishFrame.current !== null) cancelAnimationFrame(finishFrame.current);
    finishFrame.current = null;
    if (reason === "search" || reason === "switch" || reason === "return")
      cancel();
    const root = list.current;
    const snapshot =
      root && !reduced() ? capture(root, reason === "remove") : null;
    const request = { reason, snapshot, ids: ids ? new Set(ids) : undefined };
    prepared.current = request;
    if (reason === "remove" && snapshot && scene.current) {
      if (!batches.current.size) {
        order.current = new Map(
          [...snapshot.items.keys()].map((key, i) => [key, i]),
        );
      }
      // Preserve scroll extent even between the data commit and its layout effect.
      const height = [...batches.current].reduce(
        (total, batch) => total + batch.height,
        0,
      );
      scene.current.end.style.display = "block";
      scene.current.end.style.top = `${Math.max(0, snapshot.end + height - 1)}px`;
      setHasExits(true);
    }
    return () => {
      if (prepared.current !== request) return;
      // Let the final data commit consume the snapshot before clearing a no-op or failed action.
      finishFrame.current = requestAnimationFrame(() => {
        finishFrame.current = null;
        if (prepared.current !== request) return;
        prepared.current = null;
        applyHolds();
        setHasExits(batches.current.size > 0);
      });
    };
  }

  function retain(before: Snapshot, after: Snapshot) {
    const current = scene.current;
    if (!current) return;
    const removed = [...before.items.values()].filter(
      (item) => !after.items.has(item.key),
    );
    const ids = new Set(removed.flatMap((item) => (item.id ? [item.id] : [])));
    if (!ids.size) return;
    const offsets = new Map<string, number>();
    // Include absent IDs too: an earlier pending exit can be undone or collapse
    // while this independent batch is still holding its own slots.
    for (const [key, rank] of order.current) {
      offsets.set(
        key,
        removed.reduce(
          (sum, item) =>
            sum +
            ((order.current.get(item.key) ?? Infinity) < rank
              ? item.rect.height
              : 0),
          0,
        ),
      );
    }
    for (const item of after.items.values()) {
      const old = before.items.get(item.key);
      if (old) offsets.set(item.key, old.naturalTop - item.naturalTop);
    }
    const batch: Batch = {
      ids,
      offsets,
      height: Math.max(0, before.end - after.end),
      ghosts: new Map(),
      timer: setTimeout(() => {
        if (!batches.current.has(batch)) return;
        release(batch, true);
        applyHolds();
        syncHighlight(false);
        setHasExits(batches.current.size > 0);
      }, 550),
    };
    batches.current.add(batch);
    const bounds = current.root.getBoundingClientRect();
    for (const item of removed) {
      const clone = item.clone;
      if (!clone) continue;
      clone.classList.remove("highlighted");
      clone.classList.add("mail-motion-ghost");
      clone.inert = true;
      clone.setAttribute("aria-hidden", "true");
      for (const node of [clone, ...clone.querySelectorAll<HTMLElement>("*")]) {
        node.removeAttribute("id");
        node.removeAttribute("data-motion-id");
        node.removeAttribute("data-highlighted");
        node.removeAttribute("autofocus");
        if (
          node.matches(
            "a, button, input, select, textarea, [tabindex], [contenteditable]",
          )
        ) {
          node.setAttribute("tabindex", "-1");
          node.removeAttribute("contenteditable");
        }
        for (const attr of [...node.attributes]) {
          if (attr.name.startsWith("on")) node.removeAttribute(attr.name);
        }
      }
      Object.assign(clone.style, {
        position: "absolute",
        left: `${item.rect.left - bounds.left - current.root.clientLeft}px`,
        top: `${item.top - current.root.scrollTop}px`,
        width: `${item.rect.width}px`,
        height: `${item.rect.height}px`,
        margin: "0",
        translate: "none",
        transform: "translateX(-100%)",
      });
      current.clip.append(clone);
      const animation = clone.animate(
        [{ transform: "translateX(0)" }, { transform: "translateX(-100%)" }],
        {
          duration: 200,
          easing: "cubic-bezier(.525,.0825,.215,1.18)",
          fill: "backwards",
        },
      );
      const ghost: Ghost = { node: clone, top: item.top, animation };
      batch.ghosts.set(item.key, ghost);
      animation.onfinish = () => {
        animation.onfinish = null;
        clone.style.visibility = "hidden";
        animation.cancel();
        ghost.animation = null;
      };
    }
  }

  useLayoutEffect(
    () => () => {
      clear(false);
      scene.current?.dispose();
      scene.current?.owner.replaceChildren();
      scene.current = null;
      previous.current = null;
    },
    [],
  );

  useLayoutEffect(() => {
    latest.current = options;
    const root = list.current;
    const layer = owner.current;
    const request = prepared.current;
    const first = !previous.current;
    const viewChanged = previous.current?.viewKey !== options.viewKey;
    const rowsChanged = previous.current?.rowsKey !== options.rowsKey;
    const replaced =
      scene.current?.root !== root || scene.current?.owner !== layer;
    if (replaced) {
      clear();
      scene.current?.dispose();
      scene.current?.owner.replaceChildren();
      scene.current = null;
    }
    if (!root || !layer) {
      previous.current = { rowsKey: options.rowsKey, viewKey: options.viewKey };
      return;
    }
    if (!scene.current) {
      const create = (name: string) => {
        const node = document.createElement("div");
        node.className = name;
        return node;
      };
      const style = document.createElement("style");
      const background = create("mail-motion-highlight");
      const bar = create("mail-motion-bar");
      const ink = create("mail-motion-bar-ink");
      const clip = create("mail-motion-exits");
      const end = create("mail-motion-end");
      bar.append(ink);
      layer.append(style, background, bar, clip, end);
      const media = matchMedia("(prefers-reduced-motion: reduce)");
      const onMedia = () => {
        if (media.matches) cancel();
      };
      const onScroll = (event: Event) => {
        if (
          event.target === document ||
          event.target === root ||
          (event.target instanceof Element && event.target.contains(root))
        )
          cancel();
      };
      const observer = new ResizeObserver(() => {
        const rect = root.getBoundingClientRect();
        if (rect.width !== width || rect.height !== height) cancel();
        width = rect.width;
        height = rect.height;
      });
      let { width, height } = root.getBoundingClientRect();
      observer.observe(root);
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", cancel);
      media.addEventListener("change", onMedia);
      scene.current = {
        root,
        owner: layer,
        style,
        background,
        bar,
        ink,
        clip,
        end,
        dispose: () => {
          observer.disconnect();
          window.removeEventListener("scroll", onScroll, true);
          window.removeEventListener("resize", cancel);
          media.removeEventListener("change", onMedia);
        },
      };
    }
    const reason = request?.reason;
    const instant = reduced();
    const reset =
      instant || viewChanged || reason === "search" || reason === "switch";
    if (reset || (rowsChanged && !request)) clear();
    const before = request?.snapshot;
    let waitingForChange = false;
    if (
      !reset &&
      !replaced &&
      before?.root === root &&
      (reason === "remove" || reason === "undo")
    ) {
      scene.current.style.textContent = "";
      const after = capture(root, false, false);
      const restored = [...after.items.values()].filter(
        (item) => !before.items.has(item.key),
      );
      const changed = (reason === "remove"
        ? [...before.items.values()].filter(item => !after.items.has(item.key))
        : restored).some(item => item.id && (!request?.ids || request.ids.has(item.id)));
      if (!changed) {
        waitingForChange = true;
        if (batches.current.size) applyHolds(after);
        if (rowsChanged && request) {
          request.snapshot = capture(root, reason === "remove");
          if (!batches.current.size) {
            order.current = new Map([...request.snapshot.items.keys()].map((key, index) => [key, index]));
            scene.current.end.style.top = `${Math.max(0, request.snapshot.end - 1)}px`;
          }
        }
      } else {
        const canceled = [...batches.current].filter((batch) =>
          [...after.items.values()].some(
            (item) => item.id && batch.ids.has(item.id),
          ),
        );
        if (reason === "undo") {
          for (const batch of batches.current) {
            for (const [key, ghost] of batch.ghosts) {
              const rank = order.current.get(key) ?? Infinity;
              ghost.top +=
                restored.reduce(
                  (sum, item) =>
                    sum +
                    ((order.current.get(item.key) ?? Infinity) < rank
                      ? item.rect.height
                      : 0),
                  0,
                ) -
                canceled.reduce(
                  (sum, canceledBatch) =>
                    sum + (canceledBatch.offsets.get(key) || 0),
                  0,
                );
            }
          }
        }
        for (const batch of canceled) release(batch, false);
        if (reason === "remove") retain(before, after);
        applyHolds(after);
        setHasExits(batches.current.size > 0);
      }
    } else if (batches.current.size) {
      applyHolds();
    } else if (reason === "remove") {
      applyHolds();
      setHasExits(false);
    }
    syncHighlight(
      instant ||
        options.instantHighlight ||
        first ||
        replaced ||
        (viewChanged && reason !== "return") ||
        reason === "undo" ||
        reason === "search" ||
        reason === "switch",
      reason === "return",
    );
    if (!waitingForChange) prepared.current = null;
    previous.current = { rowsKey: options.rowsKey, viewKey: options.viewKey };
  });

  return {
    prepare,
    cancel,
    onScroll: cancel,
    refreshHighlight: () => syncHighlight(true),
    hasExits,
    layers: (
      <div
        className="mail-motion-layer"
        data-mail-motion={scope}
        ref={owner}
        aria-hidden="true"
        inert
      />
    ),
  };
}
