/** A hero number. A tone marks the verdict (good / bad for us), never a series colour. */
export interface StatTile {
	value: string | null;
	label: string;
	note?: string;
	tone?: "good" | "bad";
}
