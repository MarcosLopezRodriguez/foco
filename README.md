# Foco — Solo una tarea visible

Aplicación React (Vite + TS) enfocada en **mostrar solo una tarea a la vez** para reducir el agobio y mejorar la concentración.

## Pila
- React + Vite (TypeScript)
- TailwindCSS
- Zustand (estado)
- Dexie (IndexedDB)
- dnd-kit (drag & drop en Triage)
- Framer Motion (transiciones y gestos)
- date-fns, lucide-react

## Puesta en marcha

```bash
npm install
npm run dev
```

Abre http://localhost:5173

## Estructura
- `src/App.tsx` — toda la lógica del MVP (Foco, Triage, Stats, Ajustes).
- `src/main.tsx` — arranque de React.
- `src/index.css` — Tailwind.

## Notas
- Persistencia local en IndexedDB (Dexie).
- Seed de 3 tareas si la base está vacía.
- Gestos en Foco: **swipe derecha** (completar), **swipe izquierda** (posponer 1h).
- Triage con filtros (Hoy / Backlog / Todas) y arrastre para reordenar.

¡Disfruta! ✨
