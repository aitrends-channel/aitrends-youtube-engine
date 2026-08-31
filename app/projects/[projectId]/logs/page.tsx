// The credit usage log, at a URL that says so.
//
// The same page as ../cost, not a copy of it. That page already renders inside
// the wizard shell and already picks between the log and the provider matrix on
// the account's plan, so a second implementation would be two things to keep in
// step for one view. /cost stays for the accounts still billed in provider
// units and for anything linking to it.
export { default } from "../cost/page";
