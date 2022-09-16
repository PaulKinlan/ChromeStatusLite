onload = async () => {
  const url = new URL(location);
  let version = url.searchParams.get("version");

  const versionEl = document.getElementById("version");
  versionEl.onchange = async (event) => {
    event.target.form.submit();
  };
};