import { useEffect } from "react";
import { api } from "../api";

export function SignedOut({ note, error }: { note: string | null; error: string | null }) {
  useEffect(() => {
    document.title = "Resumatic";
  }, []);

  return (
    <main className="splash" id="main">
      <div className="welcome">
        <h1>Resumatic</h1>
        <p className="lede">
          Resumatic turns your resumes and CVs into a set of facts, each backed by the exact words it came from. It
          then tailors a resume to every job you apply for using only the facts you have confirmed, and never invents
          a claim.
        </p>
        {note && (
          <p className="notice" role="status">
            {note}
          </p>
        )}
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <a className="button primary large" href={api.loginUrl}>
          Sign in with Google
        </a>
        <p className="fine-print">Private beta. You can download or delete your data at any time.</p>
      </div>
    </main>
  );
}
