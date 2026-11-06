import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { installCompanyAIChatWriter } from "../lib/company-ai-reader";
import { companyAIChatOrigins } from "../lib/provider-origins";

export default defineUnlistedScript(() => {
  installCompanyAIChatWriter(companyAIChatOrigins);
});