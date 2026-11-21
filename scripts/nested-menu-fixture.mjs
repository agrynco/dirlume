import { createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { MainMenu } from "../src/MainMenu.tsx";

const ref = createRef();
const groups = [{ label: "Files", items: [{ label: "More", items: [
  { label: "Run item", run: () => { document.getElementById("result").textContent = "Item ran"; } },
] }] }];
createRoot(document.getElementById("fixture")).render(createElement(MainMenu, {
  ref, hiddenByDefault: true, shortcut: "F9", groups,
}));
window.addEventListener("keydown", (event) => {
  if (event.key !== "F9") return;
  event.preventDefault();
  ref.current?.open();
});
