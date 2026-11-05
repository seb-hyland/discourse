// Lists recent folders to reopen, beside a button to pick another. `discourse` is from preload.cjs.

document.getElementById("choose").onclick = () => discourse.choose();

const element = (tag, text) => Object.assign(document.createElement(tag), { textContent: text ?? "" });

discourse.recents().then((recents) => {
  const list = document.querySelector("#recent ul");
  for (const { root, name, location } of recents) {
    const button = element("button");
    button.append(element("strong", name), element("span", location));
    button.onclick = () => discourse.open(root);
    list.append(element("li"));
    list.lastChild.append(button);
  }
  document.querySelector("#recent .empty").hidden = recents.length > 0;
});
