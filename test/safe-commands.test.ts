import { describe, expect, it } from "vitest";
import { isReadOnlyCommand } from "../src/pi/safe-commands.ts";

describe("Brave Auto: read-only shell commands", () => {
	it("runs reading commands, lists and pipes of them", () => {
		for (const c of [
			"git status",
			"git branch --show-current && git status --short && git log -n 5 --oneline",
			"git diff --stat origin/main...HEAD",
			"ls -la src | head -20",
			'grep -rn "a|b > c" src',
			"rg TODO src; wc -l README.md",
			"cd src && find . -name '*.ts'",
			"cat package.json 2>/dev/null",
		]) {
			expect(isReadOnlyCommand(c), c).toBe(true);
		}
	});
	it("asks for anything that writes, runs other programs or is not understood", () => {
		for (const c of [
			"rm -rf build",
			"echo hi > notes.txt",
			"cat a >> b",
			"git commit -m x",
			"git push",
			"git branch -D old",
			"git branch feature",
			"git reflog expire --all",
			"git diff --output=patch.diff",
			"git -C repo status",
			"find . -name '*.tmp' -delete",
			"find . -exec rm {} ;",
			"ls $(pwd)",
			"echo `whoami`",
			'echo "$HOME"',
			"npm test",
			"FOO=1 ls",
			"sleep 10 &",
			"sort -o out.txt in.txt",
			"(cd x && ls)",
			"ls 'unterminated",
			"",
		]) {
			expect(isReadOnlyCommand(c), c).toBe(false);
		}
	});
});
