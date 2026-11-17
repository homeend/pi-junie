# pi-junie

Pi extension in development.

## Run

```bash
./scripts/dev.sh                 # installed `pi` with this extension loaded (-e)
./scripts/dev.sh --clean         # only this extension, no others
./scripts/dev.sh --cwd ~/project # work in another directory
./scripts/dev.sh --source        # Pi from ../pi checkout (needs `npm install` there)
./scripts/dev.sh -- --model x    # extra pi args
```

Edit `index.ts` and run `/reload` inside Pi. There's no build step.
Type check with `npm run typecheck`.

## Reference

- Extension API: `../pi/packages/coding-agent/docs/extensions.md`
- Examples: `../pi/packages/coding-agent/examples/extensions/`
