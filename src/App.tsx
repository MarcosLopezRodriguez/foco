import React, { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import Dexie, { Table } from "dexie";
import { DndContext, closestCenter, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { motion, AnimatePresence } from "framer-motion";
import {
  format,
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  addMonths,
  subMonths,
  isBefore,
  isAfter,
  parseISO,
  isSameDay,
} from "date-fns";
import { es } from "date-fns/locale";
import { Check, Clock, Settings as SettingsIcon, List as ListIcon, Target, ChevronLeft, ChevronRight, Plus, X, Trash, Pause, Play, AlarmClock, CalendarDays } from "lucide-react";

/**
 * "Foco" — MVP en un solo archivo para ejecutar dentro de un proyecto React + Tailwind.
 *
 * - Estado: Zustand (local) + persistencia simple Dexie (IndexedDB).
 * - Vistas: Triage (lista con DnD), Foco (una tarjeta), Stats, Settings.
 * - Interacciones clave: añadir, completar, snooze, saltar, reordenar.
 * - Animaciones: Framer Motion; gestos de swipe en FocusView.
 * - DnD: dnd-kit (lista vertical).
 *
 * Copia este archivo como src/App.tsx y arranca con Tailwind configurado.
 */

// ------------------------- Tipos de dominio -------------------------

type Priority = "pinned" | "high" | "normal" | "low";

type Subtask = {
  id: string;
  title: string;
  done: boolean;
};

type Task = {
  id: string;
  title: string;
  notes?: string;
  estado: "activa" | "hecha" | "archivada";
  priority: Priority;
  estimateMin?: number;
  dueAt?: string | null; // ISO datetime
  scheduledAt?: string | null; // ISO date or datetime
  snoozeUntil?: string | null; // ISO datetime
  completedAt?: string | null; // ISO datetime when completed
  createdAt: string; // ISO
  orderIndex: number;
  tags?: string[];
  skipsCount: number;
  subtasks?: Subtask[];
};

type Settings = {
  capacityMinutes: number;
  skipLimit: number;
  confirmSnooze: boolean;
};

// ------------------------- Utilidades -------------------------

const uuid = () => (crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

const nowIso = () => new Date().toISOString();

const toIsoDate = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();

const isEligibleForToday = (t: Task, now = new Date()) => {
  const todayEnd = endOfDay(now);
  const scheduledOk = !t.scheduledAt || isBefore(parseISO(t.scheduledAt), todayEnd) || +parseISO(t.scheduledAt) === +todayEnd;
  const notSnoozed = !t.snoozeUntil || !isAfter(parseISO(t.snoozeUntil), now);
  return t.estado === "activa" && scheduledOk && notSnoozed;
};

const byOrder = (a: Task, b: Task) => a.orderIndex - b.orderIndex;

const priorityRank: Record<Priority, number> = { pinned: 3, high: 2, normal: 1, low: 0 };

const sortQueue = (a: Task, b: Task) => {
  if (priorityRank[a.priority] !== priorityRank[b.priority]) return priorityRank[b.priority] - priorityRank[a.priority];
  const aDue = a.dueAt ? parseISO(a.dueAt) : null;
  const bDue = b.dueAt ? parseISO(b.dueAt) : null;
  if (aDue && bDue && +aDue !== +bDue) return +aDue - +bDue;
  if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
  return +parseISO(a.createdAt) - +parseISO(b.createdAt);
};

// ------------------------- Dexie DB -------------------------

class AppDB extends Dexie {
  tasks!: Table<Task, string>;
  constructor() {
    super("foco-db");
    this.version(1).stores({
      tasks: "id, estado, dueAt, scheduledAt, snoozeUntil, orderIndex, createdAt",
    });
  }
}

const db = new AppDB();

// ------------------------- Zustand Store -------------------------

type AppState = {
  tasks: Task[];
  settings: Settings;
  focusIndex: number;
  hydrateState: () => Promise<void>;
  addTask: (partial: Partial<Task> & { title: string }) => void;
  updateTask: (id: string, patch: Partial<Task>) => void;
  removeTask: (id: string) => void;
  completeTask: (id: string) => void;
  snoozeTask: (id: string, untilIso: string) => void;
  skipTask: (id: string) => void;
  reorder: (idsInOrder: string[]) => void;
  setFocusIndex: (i: number) => void;
  clearDoneToday: () => void;
};

const useAppStore = create<AppState>((set, get) => ({
  tasks: [],
  settings: { capacityMinutes: 120, skipLimit: 3, confirmSnooze: false },
  focusIndex: 0,
  hydrateState: async () => {
    const rows = await db.table("tasks").toArray();
    // Si no hay datos, sembramos ejemplo mínimo
    if (!rows.length) {
      const seed: Task[] = [
        {
          id: uuid(),
          title: "Probar la app de Foco",
          notes: "Completa esta tarea para ver la transición.",
          estado: "activa",
          priority: "pinned",
          createdAt: nowIso(),
          estimateMin: 10,
          dueAt: null,
          scheduledAt: toIsoDate(new Date()),
          snoozeUntil: null,
          orderIndex: 0,
          tags: ["demo"],
          skipsCount: 0,
        },
        {
          id: uuid(),
          title: "Escribir 3 bullets del informe",
          estado: "activa",
          priority: "high",
          createdAt: nowIso(),
          estimateMin: 20,
          dueAt: null,
          scheduledAt: toIsoDate(new Date()),
          snoozeUntil: null,
          orderIndex: 1,
          tags: ["trabajo"],
          skipsCount: 0,
        },
        {
          id: uuid(),
          title: "Comprar café",
          estado: "activa",
          priority: "normal",
          createdAt: nowIso(),
          estimateMin: 5,
          dueAt: null,
          scheduledAt: null,
          snoozeUntil: null,
          orderIndex: 2,
          tags: ["hogar"],
          skipsCount: 0,
        },
      ];
      await db.table("tasks").bulkAdd(seed);
      set({ tasks: seed });
    } else {
      set({ tasks: rows.sort(byOrder) });
    }
  },
  persistNow: undefined as any,
  addTask: (partial) => {
    const current = get().tasks;
    const orderIndex = current.length ? Math.max(...current.map((t) => t.orderIndex)) + 1 : 0;
    const t: Task = {
      id: uuid(),
      title: partial.title,
      notes: partial.notes ?? "",
      estado: partial.estado ?? "activa",
      priority: partial.priority ?? "normal",
      estimateMin: partial.estimateMin,
      dueAt: partial.dueAt ?? null,
      scheduledAt: partial.scheduledAt ?? toIsoDate(new Date()),
      snoozeUntil: partial.snoozeUntil ?? null,
      completedAt: null,
      createdAt: nowIso(),
      orderIndex,
      tags: partial.tags ?? [],
      skipsCount: 0,
      subtasks: partial.subtasks ?? [],
    };
    set({ tasks: [...current, t] });
    // Persistencia async (no bloquea UI)
    db.table("tasks").add(t).catch(console.error);
  },
  updateTask: (id, patch) => {
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
    db.table("tasks").update(id, patch).catch(console.error);
  },
  removeTask: (id) => {
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
    db.table("tasks").delete(id).catch(console.error);
  },
  completeTask: (id) => {
    const t = get().tasks.find((x) => x.id === id);
    if (!t) return;
    const patch: Partial<Task> = { estado: "hecha", snoozeUntil: null, completedAt: nowIso() };
    get().updateTask(id, patch);
  },
  snoozeTask: (id, untilIso) => {
    get().updateTask(id, { snoozeUntil: untilIso });
  },
  skipTask: (id) => {
    const { tasks } = get();
    const maxOrder = tasks.length ? Math.max(...tasks.map((t) => t.orderIndex)) : 0;
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const patch: Partial<Task> = { orderIndex: maxOrder + 1, skipsCount: (t.skipsCount || 0) + 1 };
    get().updateTask(id, patch);
  },
  reorder: (idsInOrder) => {
    set((s) => {
      const mapIndex: Record<string, number> = {};
      idsInOrder.forEach((id, i) => (mapIndex[id] = i));
      const tasks = s.tasks.map((t) => ({ ...t, orderIndex: mapIndex[t.id] ?? t.orderIndex }));
      // Persistencia: reemplazo optimista sin bloquear
      db.transaction("rw", db.table("tasks"), async () => {
        await db.table("tasks").clear();
        await db.table("tasks").bulkAdd(tasks);
      }).catch(console.error);
      return { tasks };
    });
  },
  setFocusIndex: (i) => set({ focusIndex: i }),
  clearDoneToday: () => {
    const today = startOfDay(new Date());
    set((s) => {
      const keep = s.tasks.filter(
        (t) => !(t.estado === "hecha" && parseISO(t.completedAt ?? t.createdAt) >= today)
      );
      db.transaction("rw", db.table("tasks"), async () => {
        await db.table("tasks").clear();
        await db.table("tasks").bulkAdd(keep);
      }).catch(console.error);
      return { tasks: keep };
    });
  },
}));

// ------------------------- Componentes UI básicos -------------------------

function TopNav({ view, setView }: { view: View; setView: (v: View) => void }) {
  return (
    <div className="sticky top-0 z-30 backdrop-blur bg-white/70 dark:bg-neutral-900/70 border-b border-neutral-200 dark:border-neutral-800">
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-2">
        <span className="font-bold text-lg tracking-tight">Foco</span>
        <div className="ml-auto flex items-center gap-1 text-sm">
          <NavBtn icon={<Target size={16} />} active={view === "focus"} onClick={() => setView("focus")}>
            Foco
          </NavBtn>
          <NavBtn icon={<ListIcon size={16} />} active={view === "triage"} onClick={() => setView("triage")}>
            Triage
          </NavBtn>
          <NavBtn icon={<Clock size={16} />} active={view === "stats"} onClick={() => setView("stats")}>
            Stats
          </NavBtn>
          <NavBtn icon={<CalendarDays size={16} />} active={view === "calendar"} onClick={() => setView("calendar")}>
            Calendario
          </NavBtn>
          <NavBtn icon={<SettingsIcon size={16} />} active={view === "settings"} onClick={() => setView("settings")}>
            Ajustes
          </NavBtn>
        </div>
      </div>
    </div>
  );
}

function NavBtn({ children, icon, onClick, active }: any) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full transition border ${
        active
          ? "bg-neutral-900 text-white border-neutral-900 dark:bg-white dark:text-neutral-900 dark:border-white"
          : "bg-white/70 dark:bg-neutral-900/70 text-neutral-700 dark:text-neutral-200 border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="max-w-5xl mx-auto px-4 py-6">
      <h2 className="text-sm uppercase tracking-wide text-neutral-500 mb-2">{title}</h2>
      <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl p-4 shadow-sm">{children}</div>
    </section>
  );
}

function Badge({ children, tone = "gray" as "gray" | "red" | "green" | "blue" }: { children: React.ReactNode, tone?: "gray" | "red" | "green" | "blue" }) {
  const palette: any = {
    gray: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    red: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
    green: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
    blue: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  };
  return <span className={`px-2 py-0.5 rounded-full text-xs ${palette[tone]}`}>{children}</span>;
}

function IconBtn({ title, onClick, children }: any) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="p-2 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
    >
      {children}
    </button>
  );
}

// ------------------------- TaskComposer -------------------------

function TaskComposer() {
  const addTask = useAppStore((s) => s.addTask);
  const [title, setTitle] = useState("");
  const [estimate, setEstimate] = useState<number | "">("");
  const [priority, setPriority] = useState<Priority>("normal");

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    addTask({
      title: title.trim(),
      estimateMin: estimate === "" ? undefined : Number(estimate),
      priority,
    });
    setTitle("");
    setEstimate("");
    setPriority("normal");
  };

  return (
    <form onSubmit={onSubmit} className="flex gap-2 items-center">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Añadir tarea…"
        className="flex-1 bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-600"
      />
      <select
        className="bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-xl px-2 py-2"
        value={priority}
        onChange={(e) => setPriority(e.target.value as Priority)}
        title="Prioridad"
      >
        <option value="pinned">Fijada</option>
        <option value="high">Alta</option>
        <option value="normal">Normal</option>
        <option value="low">Baja</option>
      </select>
      <input
        type="number"
        min={1}
        value={estimate}
        onChange={(e) => setEstimate(e.target.value ? Number(e.target.value) : "")}
        placeholder="min"
        className="w-20 bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-xl px-3 py-2"
      />
      <button
        type="submit"
        className="inline-flex items-center gap-2 bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 rounded-xl px-4 py-2 hover:opacity-90"
      >
        <Plus size={16} /> Añadir
      </button>
    </form>
  );
}

// ------------------------- Triage (lista + DnD) -------------------------

function TriageView() {
  const tasks = useAppStore((s) => s.tasks);
  const reorder = useAppStore((s) => s.reorder);
  const update = useAppStore((s) => s.updateTask);
  const remove = useAppStore((s) => s.removeTask);

  const [filter, setFilter] = useState<"hoy" | "backlog" | "todas">("hoy");

  const list = useMemo(() => {
    const now = new Date();
    const todayEnd = endOfDay(now);
    let base = tasks.filter((t) => t.estado === "activa");
    if (filter === "hoy") base = base.filter((t) => isEligibleForToday(t, now));
    if (filter === "backlog") base = base.filter((t) => !t.scheduledAt || isAfter(parseISO(t.scheduledAt), todayEnd));
    return base.sort(sortQueue);
  }, [tasks, filter]);

  const sensors = useSensors(
    useSensor(MouseSensor),
    useSensor(TouchSensor),
    useSensor(KeyboardSensor)
  );

  function handleDragEnd(event: any) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const currentIndex = list.findIndex((t) => t.id === active.id);
    const overIndex = list.findIndex((t) => t.id === over.id);
    if (currentIndex < 0 || overIndex < 0) return;
    const newList = arrayMove(list, currentIndex, overIndex);
    reorder(newList.map((t) => t.id));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <TaskComposer />
        <div className="flex items-center gap-2">
          <FilterChip label="Hoy" active={filter === "hoy"} onClick={() => setFilter("hoy")} />
          <FilterChip label="Backlog" active={filter === "backlog"} onClick={() => setFilter("backlog")} />
          <FilterChip label="Todas" active={filter === "todas"} onClick={() => setFilter("todas")} />
        </div>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={list.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-2">
            {list.map((t) => (
              <SortableItem key={t.id} id={t.id}>
                <li className="bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl p-3">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h4 className="font-medium truncate">{t.title}</h4>
                        {t.priority === "pinned" && <Badge tone="blue">Fijada</Badge>}
                        {t.priority === "high" && <Badge tone="red">Alta</Badge>}
                        {t.estimateMin ? <Badge>{t.estimateMin}m</Badge> : null}
                        {t.dueAt ? <Badge tone="red">vence {format(parseISO(t.dueAt), "PPP p", { locale: es })}</Badge> : null}
                        {t.snoozeUntil && isAfter(parseISO(t.snoozeUntil), new Date()) ? (
                          <Badge tone="gray">pospuesta hasta {format(parseISO(t.snoozeUntil), "p", { locale: es })}</Badge>
                        ) : null}
                      </div>
                      {t.notes ? <p className="text-sm text-neutral-500 mt-1 line-clamp-2">{t.notes}</p> : null}
                      <div className="mt-2 flex items-center gap-2 text-xs text-neutral-500">
                        <span>Creada {format(parseISO(t.createdAt), "PPP", { locale: es })}</span>
                        {t.tags?.length ? <span>• {t.tags.map((x) => `#${x}`).join(" ")}</span> : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <IconBtn title="Completar" onClick={() => useAppStore.getState().completeTask(t.id)}>
                        <Check size={16} />
                      </IconBtn>
                      <IconBtn title="Posponer 1h" onClick={() => useAppStore.getState().snoozeTask(t.id, new Date(Date.now() + 60 * 60 * 1000).toISOString())}>
                        <AlarmClock size={16} />
                      </IconBtn>
                      <IconBtn title="Programar mañana" onClick={() => update(t.id, { scheduledAt: toIsoDate(new Date(Date.now() + 24 * 60 * 60 * 1000)) })}>
                        <CalendarDays size={16} />
                      </IconBtn>
                      <IconBtn title="Eliminar" onClick={() => remove(t.id)}>
                        <Trash size={16} />
                      </IconBtn>
                    </div>
                  </div>
                </li>
              </SortableItem>
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {!list.length ? (
        <div className="text-center text-neutral-500 py-6">No hay tareas en esta vista.</div>
      ) : null}
    </div>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-sm border transition ${
        active
          ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 border-neutral-900 dark:border-white"
          : "bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      }`}
    >
      {label}
    </button>
  );
}

function SortableItem({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    touchAction: "manipulation",
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}

// ------------------------- Focus (una tarjeta) -------------------------

type View = "focus" | "triage" | "stats" | "calendar" | "settings";

function FocusView() {
  const tasks = useAppStore((s) => s.tasks);
  const complete = useAppStore((s) => s.completeTask);
  const snooze = useAppStore((s) => s.snoozeTask);
  const skip = useAppStore((s) => s.skipTask);

  const focusIndex = useAppStore((s) => s.focusIndex);
  const setFocusIndex = useAppStore((s) => s.setFocusIndex);

  const queue = useMemo(() => tasks.filter((t) => isEligibleForToday(t)).sort(sortQueue), [tasks]);

  useEffect(() => {
    if (focusIndex >= queue.length) setFocusIndex(0);
  }, [queue.length, focusIndex, setFocusIndex]);

  const current = queue[focusIndex];

  function next() {
    setFocusIndex((focusIndex + 1) % Math.max(queue.length, 1));
  }

  if (!queue.length) {
    return (
      <div className="text-center py-16 text-neutral-500">
        <p className="mb-2">No hay nada para ahora mismo.</p>
        <p className="text-sm">Añade una tarea o mueve algo a Hoy desde Triage.</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <AnimatePresence mode="popLayout">
        {current && (
          <motion.div
            key={current.id}
            layout
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.25 }}
          >
            <SwipeCard
              task={current}
              onComplete={() => complete(current.id)}
              onSnooze={(ms) => snooze(current.id, new Date(Date.now() + ms).toISOString())}
              onSkip={() => skip(current.id)}
              onNext={next}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <div className="mt-4 text-center text-sm text-neutral-500">{focusIndex + 1} / {queue.length}</div>
    </div>
  );
}

function SwipeCard({ task, onComplete, onSnooze, onSkip, onNext }: { task: Task; onComplete: () => void; onSnooze: (ms: number) => void; onSkip: () => void; onNext: () => void }) {
  const [dragX, setDragX] = useState(0);
  const [showNotes, setShowNotes] = useState(false);
  const [timerRunning, setTimerRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    setDragX(0);
    setTimerRunning(false);
    setSeconds(0);
  }, [task.id]);

  useEffect(() => {
    if (!timerRunning) return;
    const iv = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, [timerRunning]);

  const threshold = 120; // px para confirmar acción por swipe

  return (
    <motion.div
      className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-3xl p-6 shadow-xl select-none"
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      onDrag={(e, info) => setDragX(info.point.x)}
      onDragEnd={(e, info) => {
        const dx = info.offset.x;
        if (dx > threshold) {
          onComplete();
          onNext();
        } else if (dx < -threshold) {
          onSnooze(60 * 60 * 1000); // 1h por defecto
          onNext();
        }
        setDragX(0);
      }}
      style={{ cursor: "grab" }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge tone={task.priority === "pinned" ? "blue" : task.priority === "high" ? "red" : task.priority === "low" ? "gray" : "green"}>
            {task.priority === "pinned" ? "Fijada" : task.priority === "high" ? "Alta" : task.priority === "low" ? "Baja" : "Normal"}
          </Badge>
          {task.estimateMin ? <Badge>{task.estimateMin}m</Badge> : null}
          {task.dueAt ? <Badge tone="red">vence {format(parseISO(task.dueAt), "PPP p", { locale: es })}</Badge> : null}
        </div>
        <div className="flex items-center gap-1 text-xs text-neutral-500">
          {dragX > 0 ? <span className="flex items-center gap-1 text-green-600"><Check size={14} /> soltar para completar</span> : null}
          {dragX < 0 ? <span className="flex items-center gap-1 text-amber-600"><AlarmClock size={14} /> soltar para posponer 1h</span> : null}
        </div>
      </div>

      <h1 className="text-2xl md:text-3xl font-semibold mt-3 leading-snug">{task.title}</h1>

      {task.notes ? (
        <button onClick={() => setShowNotes((v) => !v)} className="mt-2 text-sm text-neutral-500 hover:underline">
          {showNotes ? "Ocultar notas" : "Mostrar notas"}
        </button>
      ) : null}
      {showNotes && task.notes ? <p className="mt-2 text-neutral-600 dark:text-neutral-300">{task.notes}</p> : null}

      {task.subtasks?.length ? (
        <div className="mt-4">
          <p className="text-xs uppercase tracking-wide text-neutral-500">Subtareas</p>
          <ul className="mt-2 space-y-1">
            {task.subtasks.map((st) => (
              <li key={st.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={st.done} readOnly className="rounded" />
                <span className={st.done ? "line-through text-neutral-400" : ""}>{st.title}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-6 flex items-center gap-2">
        <button
          onClick={() => {
            onComplete();
            onNext();
          }}
          className="inline-flex items-center gap-2 bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 rounded-xl px-4 py-2 hover:opacity-90"
        >
          <Check size={16} /> Completar
        </button>
        <button
          onClick={() => {
            onSnooze(25 * 60 * 1000); // snooze 25m
            onNext();
          }}
          className="inline-flex items-center gap-2 bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 rounded-xl px-4 py-2 hover:bg-neutral-200 dark:hover:bg-neutral-700"
        >
          <AlarmClock size={16} /> Posponer 25m
        </button>
        <button
          onClick={() => {
            onSkip();
            onNext();
          }}
          className="inline-flex items-center gap-2 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-xl px-4 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <ChevronRight size={16} /> Siguiente
        </button>
        <Pomodoro seconds={seconds} running={timerRunning} setRunning={setTimerRunning} />
      </div>
    </motion.div>
  );
}

function Pomodoro({ seconds, running, setRunning }: { seconds: number; running: boolean; setRunning: (v: boolean) => void }) {
  const mm = Math.floor(seconds / 60).toString().padStart(2, "0");
  const ss = (seconds % 60).toString().padStart(2, "0");
  return (
    <div className="ml-auto flex items-center gap-2 text-sm">
      <span className="px-3 py-2 rounded-xl bg-neutral-100 dark:bg-neutral-800">{mm}:{ss}</span>
      <button
        onClick={() => setRunning(!running)}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        {running ? <Pause size={16} /> : <Play size={16} />} {running ? "Pausa" : "Iniciar"}
      </button>
    </div>
  );
}

// ------------------------- Stats -------------------------

function StatsView() {
  const tasks = useAppStore((s) => s.tasks);
  const today = new Date();
  const doneToday = tasks.filter(
    (t) =>
      t.estado === "hecha" &&
      isAfter(parseISO(t.completedAt ?? t.createdAt), startOfDay(today))
  );
  const active = tasks.filter((t) => t.estado === "activa");

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <div className="p-4 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900">
        <p className="text-sm text-neutral-500">Completadas hoy</p>
        <p className="text-3xl font-semibold mt-1">{doneToday.length}</p>
      </div>
      <div className="p-4 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900">
        <p className="text-sm text-neutral-500">Activas</p>
        <p className="text-3xl font-semibold mt-1">{active.length}</p>
      </div>
      <div className="p-4 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900">
        <p className="text-sm text-neutral-500">Backlog estimado</p>
        <p className="text-3xl font-semibold mt-1">
          {active.reduce((acc, t) => acc + (t.estimateMin || 0), 0)} min
        </p>
      </div>
    </div>
  );
}

// ------------------------- Calendar -------------------------

function CalendarView() {
  const tasks = useAppStore((s) => s.tasks);
  const [month, setMonth] = useState(startOfMonth(new Date()));
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const done = tasks.filter((t) => t.estado === "hecha" && (t.completedAt || t.createdAt));
  const monthStart = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const monthEnd = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const weekDays = eachDayOfInterval({
    start: startOfWeek(new Date(), { weekStartsOn: 1 }),
    end: endOfWeek(new Date(), { weekStartsOn: 1 }),
  });

  const getDayTasks = (day: Date) =>
    done.filter((t) => isSameDay(parseISO(t.completedAt ?? t.createdAt), day));

  const intensityClass = (count: number) => {
    if (count === 0) return "bg-neutral-50 dark:bg-neutral-900 border-neutral-200 dark:border-neutral-800";
    if (count <= 2)
      return "bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200/60 dark:border-emerald-800/50";
    if (count <= 5)
      return "bg-emerald-100 dark:bg-emerald-900/30 border-emerald-300/70 dark:border-emerald-800";
    return "bg-emerald-200 dark:bg-emerald-900/40 border-emerald-400/80 dark:border-emerald-700";
  };

  const today = new Date();

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <button
            className="p-1 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800"
            onClick={() => setMonth(subMonths(month, 1))}
            aria-label="Mes anterior"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            className="px-2 py-1 text-xs rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            onClick={() => setMonth(startOfMonth(new Date()))}
          >
            Hoy
          </button>
        </div>
        <h3 className="font-medium">
          {format(month, "MMMM yyyy", { locale: es })}
        </h3>
        <button
          className="p-1 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800"
          onClick={() => setMonth(addMonths(month, 1))}
          aria-label="Mes siguiente"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="mb-2 flex items-center gap-3 text-xs text-neutral-500">
        <div className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-emerald-300/80" /> Con tareas
        </div>
        <div className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-neutral-200" /> Sin tareas
        </div>
      </div>

      <div className="grid grid-cols-7 gap-2 text-xs">
        {weekDays.map((d) => (
          <div key={d.toISOString()} className="text-center font-semibold text-neutral-500">
            {format(d, "EEE", { locale: es })}
          </div>
        ))}
        {days.map((day) => {
          const dayTasks = getDayTasks(day);
          const count = dayTasks.length;
          const isCurrentMonth = day.getMonth() === month.getMonth();
          const isToday = isSameDay(today, day);
          return (
            <button
              type="button"
              onClick={() => {
                setSelectedDay(day);
                setIsOpen(true);
              }}
              key={day.toISOString()}
              className={`relative text-left min-h-[86px] p-1 rounded-xl border transition shadow-sm hover:shadow-md focus:outline-none focus:ring-2 focus:ring-emerald-400/50 ${
                intensityClass(count)
              } ${isCurrentMonth ? "" : "opacity-50"}`}
            >
              <div className="flex items-start justify-between">
                <div className={`text-[10px] ${count > 0 ? "text-emerald-700 dark:text-emerald-300" : "text-neutral-500"}`}>
                  {format(day, "d")}
                </div>
                {isToday && (
                  <span className="text-[10px] px-1 rounded bg-blue-500/10 text-blue-600 dark:text-blue-300 border border-blue-200/50 dark:border-blue-800">
                    Hoy
                  </span>
                )}
              </div>
              {count > 0 ? (
                <div className="mt-2 flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  <span className="text-[11px] text-emerald-700 dark:text-emerald-300 font-medium">
                    {count} {count === 1 ? "tarea" : "tareas"}
                  </span>
                </div>
              ) : (
                <div className="mt-2 text-[11px] text-neutral-400">Sin tareas</div>
              )}
              {count > 0 && (
                <ul className="mt-2 space-y-1">
                  {dayTasks.slice(0, 2).map((t) => (
                    <li key={t.id} className="text-[10px] truncate text-neutral-700 dark:text-neutral-200">
                      • {t.title}
                    </li>
                  ))}
                  {count > 2 && (
                    <li className="text-[10px] text-neutral-500">+ {count - 2} mas</li>
                  )}
                </ul>
              )}
            </button>
          );
        })}
      </div>

      <AnimatePresence>
        {isOpen && selectedDay && (
          <motion.div
            className="fixed inset-0 z-40 flex items-end sm:items-center justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setIsOpen(false)}
            />
            <motion.div
              className="relative z-50 w-full sm:w-[520px] max-h-[80vh] overflow-hidden rounded-2xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-2xl m-2"
              initial={{ y: 40, opacity: 0, scale: 0.98 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 40, opacity: 0, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 260, damping: 24 }}
              role="dialog"
              aria-modal="true"
            >
              <div className="p-4 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
                <div>
                  <h4 className="font-semibold">
                    {format(selectedDay, "EEEE d 'de' MMMM", { locale: es })}
                  </h4>
                  <p className="text-xs text-neutral-500">
                    {getDayTasks(selectedDay).length} {getDayTasks(selectedDay).length === 1 ? "tarea completada" : "tareas completadas"}
                  </p>
                </div>
                <button
                  className="p-1 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  onClick={() => setIsOpen(false)}
                  aria-label="Cerrar"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="p-4 max-h-[60vh] overflow-auto">
                {getDayTasks(selectedDay).length === 0 ? (
                  <div className="text-sm text-neutral-500">No hay tareas completadas este dia.</div>
                ) : (
                  <ul className="space-y-2">
                    {getDayTasks(selectedDay).map((t) => (
                      <li
                        key={t.id}
                        className="flex items-start gap-2 p-2 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/60"
                      >
                        <span className="mt-0.5 text-emerald-600 dark:text-emerald-400">
                          <Check size={16} />
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{t.title}</p>
                          {t.notes && (
                            <p className="text-xs text-neutral-500 truncate">{t.notes}</p>
                          )}
                          <p className="text-[11px] text-neutral-500 mt-1">
                            Completada: {format(parseISO(t.completedAt ?? t.createdAt), "HH:mm", { locale: es })}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ------------------------- Settings -------------------------

function SettingsView() {
  const settings = useAppStore((s) => s.settings);
  const updateTask = useAppStore((s) => s.updateTask);
  const clearDoneToday = useAppStore((s) => s.clearDoneToday);
  const [capacity, setCapacity] = useState(settings.capacityMinutes);
  const [skipLimit, setSkipLimit] = useState(settings.skipLimit);

  useEffect(() => {
    // Mantener localmente; en un proyecto real guardaríamos settings en Dexie
  }, [capacity, skipLimit]);

  return (
    <div className="space-y-4">
      <div className="p-4 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900">
        <h4 className="font-medium">Capacidad diaria (minutos)</h4>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number"
            min={15}
            value={capacity}
            onChange={(e) => setCapacity(Number(e.target.value))}
            className="w-28 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-xl px-3 py-2"
          />
          <span className="text-sm text-neutral-500">(informativo; sugiere posponer si lo excedes)</span>
        </div>
      </div>

      <div className="p-4 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900">
        <h4 className="font-medium">Límite de saltos antes de sugerir posponer</h4>
        <div className="mt-2">
          <input
            type="number"
            min={1}
            value={skipLimit}
            onChange={(e) => setSkipLimit(Number(e.target.value))}
            className="w-28 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-xl px-3 py-2"
          />
        </div>
      </div>

      <div className="p-4 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900">
        <h4 className="font-medium">Mantenimiento</h4>
        <button
          onClick={() => clearDoneToday()}
          className="mt-2 inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <Trash size={16} /> Limpiar completadas de hoy
        </button>
      </div>
    </div>
  );
}

// ------------------------- App Shell -------------------------

export default function App() {
  const [view, setView] = useState<View>("focus");
  const hydrate = useAppStore((s) => s.hydrateState);
  const tasks = useAppStore((s) => s.tasks.filter((t) => t.estado !== "archivada"));
  const total = tasks.length;
  const completed = tasks.filter((t) => t.estado === "hecha").length;
  const completion = total ? completed / total : 0;
  const remaining = total ? Math.round((1 - completion) * 100) : 0;

  const [ready, setReady] = useState(false);
  useEffect(() => {
    hydrate().finally(() => setReady(true));
  }, [hydrate]);

  return (
    <div className="min-h-screen bg-neutral-100 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      <TopNav view={view} setView={setView} />

      <div className="max-w-5xl mx-auto px-4 py-4">
        <div
          className="h-3 md:h-4 bg-neutral-200 dark:bg-neutral-800/80 rounded-full overflow-hidden ring-1 ring-neutral-300/60 dark:ring-neutral-700/50"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(completion * 100)}
        >
          <div
            className="h-full transition-all duration-500 ease-out bg-gradient-to-r from-green-500 via-emerald-500 to-teal-500 dark:from-green-400 dark:via-emerald-400 dark:to-teal-400 shadow-inner"
            style={{ width: `${completion * 100}%` }}
          />
        </div>
        <p className="mt-2 text-right text-sm md:text-base font-semibold text-neutral-600 dark:text-neutral-300">
          {remaining}% restante
        </p>
      </div>

      <Section
        title={
          view === "triage"
            ? "Triage"
            : view === "focus"
            ? "Foco"
            : view === "stats"
            ? "Estadísticas"
            : view === "calendar"
            ? "Calendario"
            : "Ajustes"
        }
      >
        {!ready ? (
          <div className="py-12 text-center text-neutral-500">Cargando…</div>
        ) : view === "triage" ? (
          <TriageView />
        ) : view === "focus" ? (
          <FocusView />
        ) : view === "stats" ? (
          <StatsView />
        ) : view === "calendar" ? (
          <CalendarView />
        ) : (
          <SettingsView />
        )}
      </Section>

      <footer className="max-w-5xl mx-auto px-4 pb-8 text-xs text-neutral-500">
        <p className="mt-4">Consejo: arrastra la tarjeta hacia la derecha para completar; hacia la izquierda para posponer 1h.</p>
      </footer>
    </div>
  );
}
