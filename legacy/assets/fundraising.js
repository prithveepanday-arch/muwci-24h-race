export const CAMPAIGN_URL = "https://give.asia/campaign/event-running_to_stop_the_traffik-1789524884";

// The official live page disallows cross-origin frames. Link directly rather
// than displaying an unverified amount or an iframe that cannot load.
export function FundraisingCard({ createElement: h }) {
  const external = { target: "_blank", rel: "noopener noreferrer" };
  return h("section", { className: "sand-fundraising", "aria-label": "Race fundraising" },
    h("span", { className: "sand-fundraising-source" }, "GIVE.asia"),
    h("h2", null, "Running to stop trafficking"),
    h("p", null, "Support the 24 Hour Race Mahindra 2026."),
    h("div", { className: "sand-fundraising-actions" },
      h("a", { href: `${CAMPAIGN_URL}/donate`, ...external }, "Donate ↗"),
      h("a", { href: `${CAMPAIGN_URL}/live`, ...external }, "View live total ↗")),
    h("small", null, "Live total and donations open on GIVE.asia."));
}
