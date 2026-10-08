/** A paper from the live research API (arXiv) or one the user saved to their library. */
export interface Paper {
  id: string; title: string; source: string; year: number; field: string; openAccess: boolean;
  summary: string; tags: string[]; keyPoints: string[]; authors: string[]; link: string;
}

export interface ResearchProject { id: string; name: string; paperIds: string[]; updated: string; tone: 'violet' | 'blue' | 'teal' | 'magenta' | 'cyan' }
