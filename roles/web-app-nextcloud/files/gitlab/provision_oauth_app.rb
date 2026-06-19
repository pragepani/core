org = (Organizations::Organization.default_organization rescue nil) || (Organizations::Organization.first rescue nil)

app = Doorkeeper::Application.find_or_initialize_by(name: "Nextcloud")
was_new = app.new_record?
app.redirect_uri = ENV.fetch("NC_REDIRECT_URI")
app.scopes = "api read_user" if app.respond_to?(:scopes=)
app.confidential = true if app.respond_to?(:confidential=)
app.organization_id = org.id if org && app.respond_to?(:organization_id=)
app.save!

secret = nil
if was_new
  secret = (app.plaintext_secret rescue nil) || app.secret
elsif ENV["NC_HAS_SECRET"].to_s.strip.empty? && app.respond_to?(:renew_secret)
  app.renew_secret
  app.save!
  secret = (app.plaintext_secret rescue nil) || app.secret
end

puts "CLIENT_ID=#{app.uid}"
puts "CLIENT_SECRET=#{secret}" unless secret.to_s.empty?
