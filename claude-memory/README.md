# Claude Memory

These files are the Claude Code memory for this project. After cloning on a new machine, run:

```bash
DEST=~/.claude/projects/$(echo "$(pwd)" | sed 's|/|-|g' | sed 's|^-||')/memory
mkdir -p "$DEST"
cp claude-memory/*.md "$DEST/"
```

Run that from the repo root. Claude will then have full project context from the first session.
