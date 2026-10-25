// Tells a new learner, once, that a free SerpApi key lets the tutor show
// photos and videos. Without it they'd only find out by looking in Settings.

import { useState } from "react";
import type { TutorStore } from "../useTutor.ts";
import { PhotoKeySteps } from "./Settings.tsx";

const DISMISSED = "lila.keyPopupDismissed";

function dismissed(): boolean {
	try {
		return localStorage.getItem(DISMISSED) === "1";
	} catch {
		return false;
	}
}

export function KeyPopup({ store, hidden }: { store: TutorStore; hidden: boolean }) {
	const [closed, setClosed] = useState(dismissed);
	const { state } = store;
	// Only once an AI is connected (the first-run Settings comes first), and only without a key.
	if (closed || hidden || !state?.model || state.webPhotos) return null;
	const close = () => {
		try {
			localStorage.setItem(DISMISSED, "1");
		} catch {
			// Private window: it may show again next time.
		}
		setClosed(true);
	};
	return (
		<div className="modal-backdrop" onClick={close}>
			<div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Photos and videos">
				<div className="modal-head">
					<h2>Photos and videos</h2>
					<button type="button" className="icon-button" onClick={close} aria-label="Close">
						×
					</button>
				</div>
				<section>
					<p>Please get a free SerpApi key to let your tutor show you photos and videos.</p>
					<p className="muted-text">It's free: 250 searches a month, no credit card, and it never charges you.</p>
					<PhotoKeySteps store={store} onSaved={close} />
					<button type="button" className="link-button" onClick={close}>
						Maybe later (you can add it any time in Settings)
					</button>
				</section>
			</div>
		</div>
	);
}
