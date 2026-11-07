/** The original answer remains history when the user later edits their fact. */
export interface InterviewProvenance {
  documentId: string;
  questionId: string;
  question: string;
  quote: string;
}
export interface InterviewAnswer {
  roleId: string | null;
  answer: string;
}
