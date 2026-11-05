import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { installCompanyAIChatReader } from "../lib/company-ai-reader";
import { companyAIChatOrigins } from "../lib/provider-origins";

export default defineUnlistedScript(() => {
  installCompanyAIChatReader(companyAIChatOrigins);
});