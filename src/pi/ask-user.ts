// `ask_user`: the agent asks the user questions through a client form. Copied from Junie's AskUserAgentAction
// (junie-agent ej-core/.../agent/actions/tools/AskUserAgentAction.kt): same name, input schema, description and
// result text, so prompts and skills written for Junie behave the same. Neutral: it asks through the core
// QuestionAsk port, the driver turns that into the client's form.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { QuestionAsk } from "../core/ports.ts";
import type { QuestionAnswers, QuestionForm } from "../core/types.ts";

export const ASK_USER_TOOL = "ask_user";

/** Junie's tool description (BASE_DOCSTRING), verbatim. */
export const ASK_USER_DESCRIPTION = `Ask the user one or more questions simultaneously.
Each question can be a free-form text question, a choice question (single or multi-select), or both.
All questions are sent at once and the tool waits for all responses before returning.
Never call this tool in the same response as \`answer\`. Use exactly one user-input channel.

IMPORTANT: Each question and each option must be a single, specific, atomic proposal.
Do NOT bundle multiple topics or decisions into one question or option.
Bad example: an option like "Use React for frontend and Spring for backend" — this bundles two decisions.
Good example: separate questions for frontend choice and backend choice, each with its own focused options.
The user must be able to agree or disagree with each option independently without accepting unrelated parts.

Each option has a required \`title\` (short label, 2-3 words) and a required \`description\` (at most one sentence by default).
The \`description\` must NOT repeat or rephrase the \`title\` — instead, it should add new information: highlight pros/cons, mention a key differentiator, or explain why the user might choose this option.
Order options by preference — the first option should be the recommended one. Do not append "(recommended)" or similar suffixes.

NEVER add an "Other", "Something else", or "I'll specify myself" option — every question with options already has a free-form text input built in, so such options are always redundant.

Only use this tool to ask the user questions. Do not use it to share updates or answer the user’s questions.
While the form is open, the user sees only \`context\` and the form.`;

/** Junie's note after a declined form. */
export const ASK_USER_DECLINED_NOTE =
	"The user declined this form without answering. Do not ask the same questions again in this turn. " +
	"Continue without these answers, or end the turn with `answer`.";

const ASK_USER_PARAMETERS = Type.Object({
	questions: Type.Array(
		Type.Object({
			name: Type.String({
				description: "A unique human-readable name identifying this question, e.g. 'Tech Stack', 'Features'. Do NOT use technical identifiers like 'tech_stack'.",
			}),
			question: Type.Optional(
				Type.String({ description: "A free-form text question to ask the user. Must focus on a single topic — do not combine multiple unrelated decisions in one question." }),
			),
			options: Type.Optional(
				Type.Array(
					Type.Object({
						title: Type.String({ description: "Short label, 2-3 words." }),
						description: Type.String({ description: "At most one sentence; adds information the title does not." }),
					}),
					{
						description:
							"List of option objects for the user to choose from. Each option must be a single, atomic proposal — never bundle multiple choices (e.g. frontend AND backend) into one option.",
					},
				),
			),
			allowMultiple: Type.Optional(Type.Boolean({ description: "If true, the user can select multiple options. Defaults to false." })),
		}),
		{ description: "List of questions to ask the user simultaneously." },
	),
	context: Type.Optional(
		Type.String({
			description: "Optional Markdown message that the user sees before the form opens. Put any explanation that the user must read to answer the questions in this field.",
		}),
	),
});

/**
 * Pi extension adding `ask_user`. `currentAsk` gives the running turn's QuestionAsk (the tool lives as long as the
 * Pi session, a turn's client callback only as long as the turn).
 */
export function askUserTool(currentAsk: () => QuestionAsk | undefined): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerTool({
			name: ASK_USER_TOOL,
			label: "Ask user",
			description: ASK_USER_DESCRIPTION,
			parameters: ASK_USER_PARAMETERS,
			async execute(_toolCallId, params, signal): Promise<{ content: { type: "text"; text: string }[]; details: { answers?: QuestionAnswers }; isError?: boolean }> {
				const form: QuestionForm = { questions: params.questions, ...(params.context?.trim() ? { context: params.context.trim() } : {}) };
				if (!form.questions.length) return { content: [{ type: "text", text: "No questions provided." }], details: {}, isError: true };
				const ask = currentAsk();
				if (!ask) return { content: [{ type: "text", text: "The user cannot be asked right now." }], details: {}, isError: true };
				const answers = await ask(form, signal ?? new AbortController().signal);
				return { content: [{ type: "text", text: formatAnswers(form, answers) }], details: { answers } };
			},
		});
	};
}

/** The tool result the model reads, in Junie's format. */
export function formatAnswers(form: QuestionForm, answers: QuestionAnswers): string {
	const declined = answers.action !== "accept";
	const parts = form.questions.map((q, i) => {
		let text = `### Response for the question "${q.name}"`;
		if (declined) return `${text}\n(declined by the user)`;
		const answer = answers.answers[i] ?? { selected: [] };
		if (answer.selected.length) text += `\nSelected options: ${answer.selected.join(", ")}`;
		if (answer.text?.trim()) text += `\nFree text response: ${answer.text.trim()}`;
		if (!answer.selected.length && !answer.text?.trim()) text += "\n(no response)";
		return text;
	});
	const formatted = parts.join("\n\n");
	return declined ? `${formatted}\n\n${ASK_USER_DECLINED_NOTE}` : formatted;
}
