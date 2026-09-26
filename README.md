# whiteboard-agents

AI agents with live presence on a shared Excalidraw board, plus the Claude Code skills that drive them.

- `whiteboard-agents/`: the `wb` CLI, room host, tests. See `whiteboard-agents/README.md` and `whiteboard-agents/docs/GUIDE.md`.
- `.claude/skills/`: `wb-board` (toolbox), `wb-agent` (one agent's loop), `wb-orchestrate` (starts the crew).

Setup:

```bash
cd whiteboard-agents
npm install
npm run skills:install   # copies the skills to ~/.claude/skills/ with absolute paths
```

Extracted from brumar/Misc with history preserved.
