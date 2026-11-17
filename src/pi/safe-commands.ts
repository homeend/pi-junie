// Brave mode "Auto": shell commands that only read are run without asking. Junie decides this with an LLM safety
// classifier; this is a conservative rule list instead: every command of a pipeline/list must be a known read-only
// command, with no redirection, substitution or flags that write. Anything unknown asks, as in Safe mode.

/** Read-only commands; a value restricts the allowed subcommands (first argument). */
const READ_ONLY: Record<string, readonly string[] | true> = {
	ls: true,
	cat: true,
	head: true,
	tail: true,
	wc: true,
	pwd: true,
	echo: true,
	printf: true,
	grep: true,
	egrep: true,
	rg: true,
	find: true,
	tree: true,
	file: true,
	stat: true,
	which: true,
	du: true,
	df: true,
	sort: true,
	uniq: true,
	cut: true,
	tr: true,
	diff: true,
	date: true,
	whoami: true,
	uname: true,
	basename: true,
	dirname: true,
	realpath: true,
	true: true,
	cd: true,
	git: ["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "blame", "describe", "shortlog", "grep", "merge-base", "cat-file", "ls-tree"],
};

/** Flags that turn an otherwise read-only command into one that writes or runs other programs. */
const WRITING_FLAGS: Record<string, RegExp> = {
	find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
	sort: /^(-o|--output)/,
	git: /^(-d|-D|-m|-M|-c|-C|-f|--delete|--move|--copy|--force|--output.*|--set-upstream.*|--unset-upstream|--edit-description|--ext-diff)$/,
	tree: /^-o$/,
};

/** True when every command in `command` only reads (see READ_ONLY); false when in doubt. */
export function isReadOnlyCommand(command: string): boolean {
	const segments = splitCommands(command);
	return !!segments && segments.length > 0 && segments.every(isReadOnlySimple);
}

/**
 * Splits a shell command line into simple commands (words), honouring quotes. Undefined when it uses anything this
 * check does not model: redirection (except discarding output), substitution, subshells, background jobs, escapes.
 */
function splitCommands(command: string): string[][] | undefined {
	const text = command.replace(/\s*(2>&1|2>\/dev\/null|>\/dev\/null|&>\/dev\/null)/g, "");
	const segments: string[][] = [];
	let words: string[] = [];
	let word = "";
	let quoted = false;
	const endWord = () => {
		if (word || quoted) words.push(word);
		word = "";
		quoted = false;
	};
	const endSegment = () => {
		endWord();
		if (words.length) segments.push(words);
		words = [];
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "'" || c === '"') {
			const close = text.indexOf(c, i + 1);
			if (close < 0) return undefined;
			const inner = text.slice(i + 1, close);
			if (c === '"' && /[`$\\]/.test(inner)) return undefined;
			word += inner;
			quoted = true;
			i = close;
		} else if (/\s/.test(c) && c !== "\n") endWord();
		else if (c === "\n" || c === ";") endSegment();
		else if (c === "|" || c === "&") {
			if (c === "&" && text[i + 1] !== "&") return undefined; // background job
			if (text[i + 1] === c) i++;
			endSegment();
		} else if ("<>`$()\\{}".includes(c)) return undefined;
		else word += c;
	}
	endSegment();
	return segments;
}

function isReadOnlySimple(words: string[]): boolean {
	const [name, ...args] = words;
	if (!name || name.includes("=")) return false;
	const rule = READ_ONLY[name];
	if (!rule) return false;
	if (rule !== true) {
		const subIndex = args.findIndex((a) => !a.startsWith("-"));
		const sub = args[subIndex];
		if (!sub || !rule.includes(sub)) return false;
		// `git branch <name>` creates a branch: only listing forms are read-only.
		if (name === "git" && sub === "branch" && args.slice(subIndex + 1).some((a) => !a.startsWith("-"))) return false;
	}
	const writing = WRITING_FLAGS[name];
	return !writing || !args.some((a) => writing.test(a));
}
