import { memo } from "react";
import type { Mail } from "./data";

function RecentOpens({ mail }: { mail: Mail[] }) {
  return (
    <section className="recent-opens">
      <h2>Recent Opens</h2>
      <div className="recent-list">
        {mail.map((m, i) => (
          <div key={m.id} className={m.group && i ? "recent-group" : ""}>
            {m.group && i > 0 && <h3>{m.group}</h3>}
            <button
              className="recent-item"
              data-recent-mail-id={m.id}
              title={`${m.from}: ${m.subject}`}
            >
              <span className="recent-top">
                <span className="recent-name">{m.from}</span>
                <time>{m.opened}</time>
              </span>
              <span className="recent-subject">{m.subject}</span>
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

export default memo(RecentOpens);
