onload = async () => {
  versionEl.onchange = async (event) => {
    event.form.submit();
  };
};