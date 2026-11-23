import type { Provider } from "@earendil-works/pi-ai";
import { jetbrainsAiProvider } from "./provider.ts";

export { jetbrainsAiProvider } from "./provider.ts";

export interface ExtensionRegistrationApi {
	registerProvider(provider: Provider): void;
}

export function registerJetbrainsAiExtension(pi: ExtensionRegistrationApi): void {
	pi.registerProvider(jetbrainsAiProvider());
}

export default registerJetbrainsAiExtension;